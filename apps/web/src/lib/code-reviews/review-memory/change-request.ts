import { captureException } from '@sentry/nextjs';
import type { CodeReviewMemoryProposal, PlatformIntegration } from '@kilocode/db/schema';
import type { ReviewMemoryProposalStatus } from '@kilocode/db/schema-types';

import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  createGitHubBranch,
  createGitHubPullRequest,
  createOrUpdateGitHubRootTextFile,
  fetchGitHubRepositoryDefaultBranch,
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import { logExceptInTest } from '@/lib/utils.server';
import {
  getProposal,
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  type ReviewMemoryOwner,
} from './db';
import { ReviewMemoryModelBoundaryError, sanitizeReviewMemoryDiagnosticMessage } from './llm';
import { generateIntegratedReviewGuidanceWithGateway } from './review-md-integration';

const REVIEW_MEMORY_TARGET_FILE_PATH = 'REVIEW.md';
const REVIEW_MEMORY_CHANGE_REQUEST_TITLE = 'docs(review): update REVIEW.md guidance';
const REVIEW_MEMORY_CHANGE_REQUEST_MARKER = '<!-- kilo-review-memory-change-request -->';
const REVIEW_MEMORY_CHANGE_REQUEST_RETRY_MESSAGE =
  'Unable to open the REVIEW.md change request. The proposal can be retried.';
const OPENING_CHANGE_REQUEST_STALE_MS = 30 * 60 * 1000;
const APPROVABLE_STATUSES: ReadonlySet<ReviewMemoryProposalStatus> = new Set([
  'open',
  'edited',
  'change_request_failed',
]);

type ReviewMemoryChangeRequestStage =
  | 'repository_validation'
  | 'installation_token_creation'
  | 'github_reads'
  | 'review_md_integration'
  | 'branch_creation'
  | 'file_writing'
  | 'pull_request_creation'
  | 'final_persistence'
  | 'failure_persistence';

type CaptureReviewMemoryException = (
  error: Error,
  context: {
    level: 'error';
    tags: {
      source: 'review-memory';
      operation: 'open-change-request';
      stage: ReviewMemoryChangeRequestStage;
    };
    extra: Record<string, unknown>;
  }
) => unknown;

export type ReviewMemoryChangeRequestOperations = {
  generateInstallationToken: typeof generateGitHubInstallationToken;
  fetchDefaultBranch: typeof fetchGitHubRepositoryDefaultBranch;
  fetchReviewMd: typeof fetchGitHubRootTextFileAtRef;
  integrateReviewMd: typeof generateIntegratedReviewGuidanceWithGateway;
  createBranch: typeof createGitHubBranch;
  writeReviewMd: typeof createOrUpdateGitHubRootTextFile;
  createPullRequest: typeof createGitHubPullRequest;
  markFailed: typeof markProposalChangeRequestFailed;
  log: (record: string) => void;
  captureException: CaptureReviewMemoryException;
};

const defaultOperations: ReviewMemoryChangeRequestOperations = {
  generateInstallationToken: generateGitHubInstallationToken,
  fetchDefaultBranch: fetchGitHubRepositoryDefaultBranch,
  fetchReviewMd: fetchGitHubRootTextFileAtRef,
  integrateReviewMd: generateIntegratedReviewGuidanceWithGateway,
  createBranch: createGitHubBranch,
  writeReviewMd: createOrUpdateGitHubRootTextFile,
  createPullRequest: createGitHubPullRequest,
  markFailed: markProposalChangeRequestFailed,
  log: logExceptInTest,
  captureException,
};

export class ReviewMemoryChangeRequestError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ReviewMemoryChangeRequestError';
  }
}

export function buildChangeRequestBody(proposal: CodeReviewMemoryProposal): string {
  return `${REVIEW_MEMORY_CHANGE_REQUEST_MARKER}

## Proposal

${proposal.title}

## Rationale

${proposal.rationale}

Kilo analyzed maintainer replies to recent review comments and found repeated feedback that this repository guidance should address. Review and edit the proposed REVIEW.md changes before merging.`;
}

export async function approveAndOpenReviewMemoryChangeRequest(
  input: {
    owner: ReviewMemoryOwner;
    proposalId: string;
    requestCorrelationId: string;
  },
  operationOverrides: Partial<ReviewMemoryChangeRequestOperations> = {}
): Promise<CodeReviewMemoryProposal> {
  const operations = { ...defaultOperations, ...operationOverrides };
  let proposal = await getProposal({ owner: input.owner, proposalId: input.proposalId });
  if (!proposal) {
    throw new ReviewMemoryChangeRequestError('NOT_FOUND', 'Review memory proposal not found.');
  }
  if (proposal.status === 'change_request_opened' && proposal.change_request_url) {
    emitChangeRequestRecord(operations.log, {
      requestCorrelationId: input.requestCorrelationId,
      stage: 'final_persistence',
      outcome: 'success',
      result: 'change_request_opened',
    });
    return proposal;
  }
  if (proposal.status === 'opening_change_request') {
    const recovered = await recoverStaleOpeningChangeRequest(proposal);
    if (!recovered) {
      throw new ReviewMemoryChangeRequestError(
        'CONFLICT',
        'Review memory proposal is already being processed.'
      );
    }
    proposal = recovered;
  }
  if (!APPROVABLE_STATUSES.has(proposal.status)) {
    throw new ReviewMemoryChangeRequestError(
      'CONFLICT',
      `Review memory proposal cannot be approved from status ${proposal.status}.`
    );
  }

  const integration = await findGitHubIntegrationForProposal(input.owner, proposal);
  assertGitHubPermissions(integration);
  const opening = await markProposalOpeningChangeRequest({ proposalId: proposal.id });
  if (!opening) {
    throw new ReviewMemoryChangeRequestError(
      'CONFLICT',
      'Review memory proposal is already being processed.'
    );
  }

  let stage: ReviewMemoryChangeRequestStage = 'repository_validation';
  try {
    const [repoOwner, repo] = proposal.repo_full_name.split('/');
    if (!repoOwner || !repo) {
      throw new Error('Invalid repository name.');
    }

    stage = 'installation_token_creation';
    if (!integration.platform_installation_id) {
      throw new Error('GitHub installation id is missing.');
    }
    const tokenData = await operations.generateInstallationToken(
      integration.platform_installation_id,
      integration.github_app_type ?? 'standard'
    );
    const token = tokenData.token;

    stage = 'github_reads';
    const defaultBranch = await operations.fetchDefaultBranch({
      token,
      owner: repoOwner,
      repo,
    });
    const existingReviewMd = await operations.fetchReviewMd({
      token,
      owner: repoOwner,
      repo,
      path: REVIEW_MEMORY_TARGET_FILE_PATH,
      ref: defaultBranch,
    });

    stage = 'review_md_integration';
    const integrationResult = await operations.integrateReviewMd({
      owner: input.owner,
      platform: 'github',
      repoFullName: proposal.repo_full_name,
      existingReviewMd,
      proposal,
      requestCorrelationId: input.requestCorrelationId,
    });

    if (integrationResult.status === 'already_present') {
      stage = 'final_persistence';
      const superseded = await markProposalSuperseded({ proposalId: proposal.id });
      if (!superseded) throw new Error('Failed to mark proposal superseded.');
      emitChangeRequestRecord(operations.log, {
        requestCorrelationId: input.requestCorrelationId,
        stage,
        outcome: 'success',
        result: 'already_present',
      });
      return superseded;
    }
    if (!integrationResult.updatedReviewMd) {
      throw new Error('Integration returned no REVIEW.md content.');
    }

    const branchName = `kilo/review-memory/${proposal.id.slice(0, 8)}`;
    stage = 'branch_creation';
    await operations.createBranch({
      token,
      owner: repoOwner,
      repo,
      branchName,
      baseBranch: defaultBranch,
    });

    stage = 'file_writing';
    await operations.writeReviewMd({
      token,
      owner: repoOwner,
      repo,
      path: REVIEW_MEMORY_TARGET_FILE_PATH,
      branch: branchName,
      message: 'Update REVIEW.md guidance',
      content: integrationResult.updatedReviewMd,
    });

    stage = 'pull_request_creation';
    const pullRequest = await operations.createPullRequest({
      token,
      owner: repoOwner,
      repo,
      title: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
      body: buildChangeRequestBody(proposal),
      headBranch: branchName,
      baseBranch: defaultBranch,
    });

    stage = 'final_persistence';
    const opened = await markProposalChangeRequestOpened({
      proposalId: proposal.id,
      changeRequestUrl: pullRequest.url,
    });
    if (!opened) throw new Error('Failed to mark proposal change request opened.');
    emitChangeRequestRecord(operations.log, {
      requestCorrelationId: input.requestCorrelationId,
      stage,
      outcome: 'success',
      result: 'change_request_opened',
    });
    return opened;
  } catch (error) {
    reportChangeRequestFailure({
      error,
      stage,
      requestCorrelationId: input.requestCorrelationId,
      proposalId: proposal.id,
      operations,
    });

    try {
      const failed = await operations.markFailed({ proposalId: proposal.id });
      if (!failed) throw new Error('Failed to mark proposal change request failed.');
    } catch (persistenceError) {
      reportChangeRequestFailure({
        error: persistenceError,
        stage: 'failure_persistence',
        failedAtStage: stage,
        requestCorrelationId: input.requestCorrelationId,
        proposalId: proposal.id,
        operations,
      });
    }

    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      REVIEW_MEMORY_CHANGE_REQUEST_RETRY_MESSAGE
    );
  }
}

export function isStaleOpeningChangeRequest(updatedAt: string, now = new Date()): boolean {
  const updatedAtMs = new Date(updatedAt).getTime();
  return (
    Number.isFinite(updatedAtMs) && now.getTime() - updatedAtMs >= OPENING_CHANGE_REQUEST_STALE_MS
  );
}

async function recoverStaleOpeningChangeRequest(
  proposal: CodeReviewMemoryProposal
): Promise<CodeReviewMemoryProposal | null> {
  if (!isStaleOpeningChangeRequest(proposal.updated_at)) return null;
  return await markProposalChangeRequestFailed({ proposalId: proposal.id });
}

async function findGitHubIntegrationForProposal(
  owner: ReviewMemoryOwner,
  proposal: CodeReviewMemoryProposal
): Promise<PlatformIntegration> {
  const integrations = await getAllIntegrationsForOwner(owner);
  const integration = integrations.find(
    integration =>
      integration.platform === PLATFORM.GITHUB &&
      integration.integration_status === INTEGRATION_STATUS.ACTIVE &&
      !integration.suspended_at &&
      integration.platform_installation_id &&
      hasRepositoryAccess(integration, proposal.repo_full_name)
  );

  if (!integration) {
    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      'No active GitHub integration has access to this repository.'
    );
  }
  return integration;
}

function hasRepositoryAccess(integration: PlatformIntegration, repoFullName: string): boolean {
  if (integration.repository_access === 'all') return true;
  return integration.repositories?.some(repo => repo.full_name === repoFullName) ?? false;
}

function assertGitHubPermissions(integration: PlatformIntegration): void {
  const permissions = integration.permissions;
  if (permissions?.contents !== 'write' || permissions.pull_requests !== 'write') {
    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      'The GitHub App needs contents:write and pull_requests:write permissions to open a REVIEW.md PR.'
    );
  }
}

function reportChangeRequestFailure(input: {
  error: unknown;
  stage: ReviewMemoryChangeRequestStage;
  failedAtStage?: ReviewMemoryChangeRequestStage;
  requestCorrelationId: string;
  proposalId: string;
  operations: ReviewMemoryChangeRequestOperations;
}): void {
  const modelDiagnostics =
    input.error instanceof ReviewMemoryModelBoundaryError ? input.error.diagnostics : null;
  const errorClass = getSafeErrorClass(input.error);
  const errorMessage = modelDiagnostics
    ? modelDiagnostics.errorMessage
    : input.stage === 'failure_persistence'
      ? 'Failed to persist the Review Memory change-request failure state.'
      : 'Review Memory change-request operation failed.';

  emitChangeRequestRecord(input.operations.log, {
    requestCorrelationId: input.requestCorrelationId,
    stage: input.stage,
    outcome: 'failure',
    errorClass,
    errorMessage,
  });

  try {
    const capturedError = createSanitizedChangeRequestError({
      sourceError: input.error,
      message: errorMessage ?? 'Review Memory change-request operation failed.',
    });
    input.operations.captureException(capturedError, {
      level: 'error',
      tags: {
        source: 'review-memory',
        operation: 'open-change-request',
        stage: input.stage,
      },
      extra: {
        requestCorrelationId: input.requestCorrelationId,
        proposalId: input.proposalId,
        errorClass,
        errorMessage,
        ...(input.failedAtStage ? { failedAtStage: input.failedAtStage } : {}),
        ...(modelDiagnostics ? { modelDiagnostics } : {}),
        ...(modelDiagnostics?.providerRequestId
          ? { providerRequestId: modelDiagnostics.providerRequestId }
          : {}),
      },
    });
  } catch {
    // Reporting must not replace the original change-request failure.
  }
}

function emitChangeRequestRecord(
  log: (record: string) => void,
  input: {
    requestCorrelationId: string;
    stage: ReviewMemoryChangeRequestStage;
    outcome: 'success' | 'failure';
    result?: 'already_present' | 'change_request_opened';
    errorClass?: string;
    errorMessage?: string | null;
  }
): void {
  try {
    log(
      JSON.stringify({
        event: 'review_memory_change_request',
        operation: 'open_change_request',
        request_correlation_id: input.requestCorrelationId,
        stage: input.stage,
        outcome: input.outcome,
        result: input.result ?? null,
        error_class: input.errorClass ?? null,
        error_message: input.errorMessage ?? null,
      })
    );
  } catch {
    // Telemetry must not affect change-request state transitions.
  }
}

function createSanitizedChangeRequestError(input: {
  sourceError: unknown;
  message: string;
}): Error {
  const capturedError = new Error(sanitizeReviewMemoryDiagnosticMessage(input.message));
  capturedError.name = 'ReviewMemoryChangeRequestFailure';
  const stackFrames = getSafeStackFrames(input.sourceError);
  if (stackFrames) {
    capturedError.stack = `${capturedError.name}: ${capturedError.message}\n${stackFrames}`;
  }
  return capturedError;
}

function getSafeStackFrames(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  const stackFrames = error.stack
    .split('\n')
    .slice(1)
    .filter(line => /^\s*at\s/.test(line))
    .slice(0, 20)
    .join('\n');
  return stackFrames ? sanitizeReviewMemoryDiagnosticMessage(stackFrames) : null;
}

function getSafeErrorClass(error: unknown): string {
  let name = 'UnknownError';
  if (error instanceof Error) {
    name = error.name;
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    name = error.name;
  }
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'UnknownError';
}
