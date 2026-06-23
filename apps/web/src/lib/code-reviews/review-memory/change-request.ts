import type { CodeReviewMemoryProposal, PlatformIntegration } from '@kilocode/db/schema';
import type { ReviewMemoryProposalStatus } from '@kilocode/db/schema-types';

import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  createGitHubBranch,
  createGitHubPullRequest,
  createOrUpdateGitHubRootTextFile,
  fetchGitHubRepositoryDefaultBranch,
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import {
  getProposal,
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  type ReviewMemoryOwner,
} from './db';
import { generateIntegratedReviewGuidanceWithGateway } from './review-md-integration';

const REVIEW_MEMORY_TARGET_FILE_PATH = 'REVIEW.md';
const REVIEW_MEMORY_CHANGE_REQUEST_TITLE = 'docs(review): update REVIEW.md guidance';
const REVIEW_MEMORY_CHANGE_REQUEST_MARKER = '<!-- kilo-review-memory-change-request -->';
const OPENING_CHANGE_REQUEST_STALE_MS = 30 * 60 * 1000;
const APPROVABLE_STATUSES: ReadonlySet<ReviewMemoryProposalStatus> = new Set([
  'open',
  'edited',
  'change_request_failed',
]);

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

export async function approveAndOpenReviewMemoryChangeRequest(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
}): Promise<CodeReviewMemoryProposal> {
  let proposal = await getProposal({ owner: input.owner, proposalId: input.proposalId });
  if (!proposal) {
    throw new ReviewMemoryChangeRequestError('NOT_FOUND', 'Review memory proposal not found.');
  }
  if (proposal.status === 'change_request_opened' && proposal.change_request_url) {
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

  try {
    const [repoOwner, repo] = proposal.repo_full_name.split('/');
    if (!repoOwner || !repo) {
      throw new Error(`Invalid repository name: ${proposal.repo_full_name}`);
    }
    if (!integration.platform_installation_id) {
      throw new Error('GitHub installation id is missing.');
    }

    const tokenData = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      integration.github_app_type ?? 'standard'
    );
    const token = tokenData.token;
    const defaultBranch = await fetchGitHubRepositoryDefaultBranch({
      token,
      owner: repoOwner,
      repo,
    });
    const existingReviewMd = await fetchGitHubRootTextFileAtRef({
      token,
      owner: repoOwner,
      repo,
      path: REVIEW_MEMORY_TARGET_FILE_PATH,
      ref: defaultBranch,
    });
    const integrationResult = await generateIntegratedReviewGuidanceWithGateway({
      owner: input.owner,
      platform: 'github',
      repoFullName: proposal.repo_full_name,
      existingReviewMd,
      proposal,
    });

    if (integrationResult.status === 'already_present') {
      const superseded = await markProposalSuperseded({ proposalId: proposal.id });
      if (!superseded) throw new Error('Failed to mark proposal superseded.');
      return superseded;
    }
    if (!integrationResult.updatedReviewMd) {
      throw new Error('Integration returned no REVIEW.md content.');
    }

    const branchName = `kilo/review-memory/${proposal.id.slice(0, 8)}`;
    await createGitHubBranch({
      token,
      owner: repoOwner,
      repo,
      branchName,
      baseBranch: defaultBranch,
    });
    await createOrUpdateGitHubRootTextFile({
      token,
      owner: repoOwner,
      repo,
      path: REVIEW_MEMORY_TARGET_FILE_PATH,
      branch: branchName,
      message: 'Update REVIEW.md guidance',
      content: integrationResult.updatedReviewMd,
    });
    const pullRequest = await createGitHubPullRequest({
      token,
      owner: repoOwner,
      repo,
      title: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
      body: buildChangeRequestBody(proposal),
      headBranch: branchName,
      baseBranch: defaultBranch,
    });
    const opened = await markProposalChangeRequestOpened({
      proposalId: proposal.id,
      changeRequestUrl: pullRequest.url,
    });
    if (!opened) throw new Error('Failed to mark proposal change request opened.');
    return opened;
  } catch (error) {
    await markProposalChangeRequestFailed({ proposalId: proposal.id });
    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      redactSensitiveErrorMessage(error instanceof Error ? error.message : String(error))
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

function redactSensitiveErrorMessage(message: string): string {
  return message.replace(/(?:ghs|ghu|ghp|github_pat)_[A-Za-z0-9_]+/g, '[redacted-token]');
}
