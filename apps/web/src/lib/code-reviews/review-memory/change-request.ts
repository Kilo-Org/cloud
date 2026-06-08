import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { warnExceptInTest } from '@/lib/utils.server';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import {
  createGitHubBranch,
  createGitHubPullRequest,
  createOrUpdateGitHubRootTextFile,
  fetchGitHubRepositoryDefaultBranch,
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import {
  createGitLabBranch,
  createGitLabMergeRequest,
  createOrUpdateGitLabTextFile,
  fetchGitLabProjectDetails,
  fetchGitLabRootTextFileAtRef,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getStoredProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';
import * as z from 'zod';
import type { CodeReviewMemoryProposal, PlatformIntegration } from '@kilocode/db/schema';
import {
  getReviewMemoryProposal,
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  type ReviewMemoryOwner,
} from './db';
import {
  generateIntegratedReviewGuidanceWithGateway,
  type ReviewMdIntegrationResult,
} from './review-md-integration';

const REVIEW_MEMORY_TARGET_FILE_PATH = 'REVIEW.md';
const REVIEW_MEMORY_CHANGE_REQUEST_TITLE = 'docs(review): update REVIEW.md guidance';
const REVIEW_MEMORY_CHANGE_REQUEST_MARKER = '<!-- kilo-review-memory-change-request -->';
const APPROVABLE_STATUSES = new Set(['open', 'edited', 'change_request_failed']);
const GitLabIntegrationMetadataSchema = z
  .object({
    gitlab_instance_url: z.string().url().optional(),
  })
  .passthrough()
  .nullable();

export class ReviewMemoryChangeRequestError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ReviewMemoryChangeRequestError';
  }
}

export type ApproveReviewMemoryChangeRequestInput = {
  owner: ReviewMemoryOwner;
  proposalId: string;
  approvedByUser: {
    id: string;
    email: string | null;
    name: string | null;
  };
};

type PrepareReviewMemoryChangeBranchInput = {
  owner: ReviewMemoryOwner;
  proposal: CodeReviewMemoryProposal;
  platform: CodeReviewMemoryProposal['platform'];
  defaultBranch: string;
  branchName: string;
  fetchContent: (ref: string) => Promise<string | null>;
  createBranch: () => Promise<void>;
  writeContent: (content: string, fileExists: boolean) => Promise<void>;
  generateIntegratedReviewGuidance?: (input: {
    owner: ReviewMemoryOwner;
    platform: CodeReviewMemoryProposal['platform'];
    repoFullName: string;
    existingReviewMd: string | null;
    proposal: CodeReviewMemoryProposal;
  }) => Promise<ReviewMdIntegrationResult>;
};

export async function approveAndOpenReviewMemoryChangeRequest(
  input: ApproveReviewMemoryChangeRequestInput
): Promise<CodeReviewMemoryProposal> {
  const proposal = await getReviewMemoryProposal({
    owner: input.owner,
    proposalId: input.proposalId,
  });
  if (!proposal) {
    throw new ReviewMemoryChangeRequestError('NOT_FOUND', 'Review memory proposal not found');
  }

  if (proposal.status === 'change_request_opened' && proposal.change_request_url) {
    return proposal;
  }

  if (!APPROVABLE_STATUSES.has(proposal.status)) {
    throw new ReviewMemoryChangeRequestError(
      'CONFLICT',
      'Only open, edited, or failed Review Memory proposals can be approved.'
    );
  }

  const integration = await resolveIntegrationForProposal(input.owner, proposal);
  const openingProposal = await markProposalOpeningChangeRequest({
    owner: input.owner,
    proposalId: proposal.id,
  });

  if (!openingProposal) {
    throw new ReviewMemoryChangeRequestError(
      'CONFLICT',
      'Review memory proposal is already being opened.'
    );
  }

  try {
    const result =
      proposal.platform === 'github'
        ? await openGitHubReviewMemoryPullRequest(input.owner, openingProposal, integration)
        : await openGitLabReviewMemoryMergeRequest(input.owner, openingProposal, integration);

    if (result.superseded) {
      return await markProposalSuperseded({ proposalId: proposal.id });
    }

    const opened = await markProposalChangeRequestOpened({
      proposalId: proposal.id,
      changeRequestUrl: result.url,
    });

    if (input.owner.type === 'org') {
      await createAuditLog({
        organization_id: input.owner.id,
        actor_id: input.approvedByUser.id,
        actor_email: input.approvedByUser.email,
        actor_name: input.approvedByUser.name,
        action: 'organization.review_memory.open_change_request',
        message: `Opened ${result.label} ${result.url} for Review Memory proposal ${proposal.title}.`,
      }).catch(error => {
        warnExceptInTest('[review-memory] Failed to create organization audit log', error);
      });
    }

    return opened;
  } catch (error) {
    const message = publicErrorMessage(error);
    await markProposalChangeRequestFailed({ proposalId: proposal.id, errorMessage: message });
    throw new ReviewMemoryChangeRequestError('BAD_REQUEST', message);
  }
}

async function openGitHubReviewMemoryPullRequest(
  owner: ReviewMemoryOwner,
  proposal: CodeReviewMemoryProposal,
  integration: PlatformIntegration
): Promise<
  { superseded: true } | { superseded: false; number: number; url: string; label: string }
> {
  if (!integration.platform_installation_id) {
    throw new Error(
      'GitHub integration is missing an installation ID. Reconnect GitHub and try again.'
    );
  }
  assertGitHubPermissions(integration.permissions);

  const repo = splitGitHubRepository(proposal.repo_full_name);
  const token = await generateGitHubInstallationToken(
    integration.platform_installation_id,
    integration.github_app_type ?? 'standard'
  );
  const defaultBranch = await fetchGitHubRepositoryDefaultBranch({ token: token.token, ...repo });
  const branchName = branchNameForProposal(proposal);
  const prepared = await prepareReviewMemoryChangeBranch({
    owner,
    proposal,
    platform: 'github',
    defaultBranch,
    branchName,
    fetchContent: ref =>
      fetchGitHubRootTextFileAtRef({
        token: token.token,
        ...repo,
        path: REVIEW_MEMORY_TARGET_FILE_PATH,
        ref,
      }),
    createBranch: () =>
      createGitHubBranch({
        token: token.token,
        ...repo,
        branchName,
        baseBranch: defaultBranch,
      }),
    writeContent: content =>
      createOrUpdateGitHubRootTextFile({
        token: token.token,
        ...repo,
        path: REVIEW_MEMORY_TARGET_FILE_PATH,
        branch: branchName,
        message: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
        content,
      }),
  });

  if (prepared.superseded) {
    return { superseded: true };
  }

  const pullRequest = await createGitHubPullRequest({
    token: token.token,
    ...repo,
    title: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
    body: buildChangeRequestBody(proposal, 'pull request'),
    headBranch: branchName,
    baseBranch: defaultBranch,
  });

  return { superseded: false, ...pullRequest, label: 'GitHub PR' };
}

async function openGitLabReviewMemoryMergeRequest(
  owner: ReviewMemoryOwner,
  proposal: CodeReviewMemoryProposal,
  integration: PlatformIntegration
): Promise<
  { superseded: true } | { superseded: false; number: number; url: string; label: string }
> {
  const projectId = proposal.platform_project_id ?? proposal.repo_full_name;
  const instanceUrl = gitLabInstanceUrl(integration.metadata);
  const token =
    resolveStoredGitLabToken(integration, projectId) ?? (await getValidGitLabToken(integration));
  const project = await fetchGitLabProjectDetails(token, projectId, instanceUrl);
  const defaultBranch = project.default_branch;
  const branchName = branchNameForProposal(proposal);
  const prepared = await prepareReviewMemoryChangeBranch({
    owner,
    proposal,
    platform: 'gitlab',
    defaultBranch,
    branchName,
    fetchContent: ref =>
      fetchGitLabRootTextFileAtRef(
        token,
        proposal.repo_full_name,
        REVIEW_MEMORY_TARGET_FILE_PATH,
        ref,
        instanceUrl
      ),
    createBranch: () =>
      createGitLabBranch(token, projectId, branchName, defaultBranch, instanceUrl),
    writeContent: (content, fileExists) =>
      createOrUpdateGitLabTextFile(
        token,
        projectId,
        branchName,
        REVIEW_MEMORY_TARGET_FILE_PATH,
        content,
        REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
        fileExists ? 'update' : 'create',
        instanceUrl
      ),
  });

  if (prepared.superseded) {
    return { superseded: true };
  }

  const mergeRequest = await createGitLabMergeRequest(
    token,
    projectId,
    branchName,
    defaultBranch,
    REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
    buildChangeRequestBody(proposal, 'merge request'),
    instanceUrl
  );

  return { superseded: false, ...mergeRequest, label: 'GitLab MR' };
}

async function resolveIntegrationForProposal(
  owner: ReviewMemoryOwner,
  proposal: CodeReviewMemoryProposal
): Promise<PlatformIntegration> {
  const integrations = await getAllIntegrationsForOwner(owner);
  const integration = integrations.find(
    item =>
      item.platform === proposal.platform &&
      item.integration_status === INTEGRATION_STATUS.ACTIVE &&
      integrationIncludesRepository(item, proposal.repo_full_name)
  );

  if (!integration) {
    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      `No active ${proposal.platform === 'github' ? 'GitHub' : 'GitLab'} integration is available for this repository.`
    );
  }

  return integration;
}

function integrationIncludesRepository(
  integration: PlatformIntegration,
  repoFullName: string
): boolean {
  if (integration.repository_access === 'all') return true;
  return (
    integration.repositories?.some(repository => repository.full_name === repoFullName) ?? false
  );
}

function splitGitHubRepository(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repoFullName.split('/');
  if (!owner || !repo || extra) {
    throw new Error('GitHub repository names must use the owner/repo format.');
  }
  return { owner, repo };
}

function assertGitHubPermissions(permissions: PlatformIntegration['permissions']): void {
  if (permissions?.contents !== 'write' || permissions?.pull_requests !== 'write') {
    throw new Error(
      'GitHub App permissions must include contents: write and pull requests: write to open REVIEW.md pull requests.'
    );
  }
}

function resolveStoredGitLabToken(
  integration: PlatformIntegration,
  projectId: string | number
): string | null {
  return getStoredProjectAccessToken(integration, projectId)?.token ?? null;
}

async function prepareReviewMemoryChangeBranch(
  input: PrepareReviewMemoryChangeBranchInput
): Promise<{ superseded: boolean }> {
  const existingContent = await input.fetchContent(input.defaultBranch);
  if (contentIncludesProposal(existingContent, input.proposal.proposed_markdown)) {
    return { superseded: true };
  }

  const generateIntegratedReviewGuidance =
    input.generateIntegratedReviewGuidance ?? generateIntegratedReviewGuidanceWithGateway;
  const integration = await generateIntegratedReviewGuidance({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.proposal.repo_full_name,
    existingReviewMd: existingContent,
    proposal: input.proposal,
  });

  if (integration.status === 'already_present') {
    return { superseded: true };
  }

  if (!integration.updatedReviewMd) {
    throw new Error('Integration generator did not return updated REVIEW.md content.');
  }

  await input.createBranch();
  const branchContent = await input.fetchContent(input.branchName);
  if (
    !contentIncludesProposal(branchContent, input.proposal.proposed_markdown) &&
    !contentIncludesProposal(branchContent, integration.updatedReviewMd)
  ) {
    const fileExistsOnBranch = branchContent ?? existingContent;
    await input.writeContent(integration.updatedReviewMd, Boolean(fileExistsOnBranch));
  }

  return { superseded: false };
}

function gitLabInstanceUrl(metadata: unknown): string {
  const parsed = GitLabIntegrationMetadataSchema.safeParse(metadata ?? null);
  if (!parsed.success) {
    throw new Error('GitLab integration metadata is malformed. Reconnect GitLab and try again.');
  }
  return parsed.data?.gitlab_instance_url ?? 'https://gitlab.com';
}

function branchNameForProposal(proposal: CodeReviewMemoryProposal): string {
  return `kilo/review-memory/${proposal.id.slice(0, 8)}`;
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function contentIncludesProposal(content: string | null, proposedMarkdown: string): boolean {
  if (!content) return false;
  return normalizeMarkdown(content).includes(normalizeMarkdown(proposedMarkdown));
}

function buildChangeRequestBody(
  proposal: CodeReviewMemoryProposal,
  platformChangeRequestName: 'pull request' | 'merge request'
): string {
  const scope = proposal.scope_value
    ? `${proposal.scope_kind}: ${proposal.scope_value}`
    : proposal.scope_kind;
  return [
    REVIEW_MEMORY_CHANGE_REQUEST_MARKER,
    '',
    `This ${platformChangeRequestName} applies a Kilo Review Memory proposal to REVIEW.md.`,
    '',
    '## Proposal',
    proposal.title,
    '',
    '## Rationale',
    proposal.rationale,
    '',
    '## Scope',
    scope,
  ].join('\n');
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*[A-Za-z0-9._~+/-]+/gi, 'token=[redacted]')
    .slice(0, 1_000);
}
