import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { warnExceptInTest } from '@/lib/utils.server';
import {
  getAllIntegrationsForOwner,
  getIntegrationById,
} from '@/lib/integrations/db/platform-integrations';
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
import type { CodeReviewMemoryProposal, PlatformIntegration } from '@kilocode/db/schema';
import type { ReviewMemoryChangeRequestType } from '@kilocode/db/schema-types';
import {
  getReviewMemoryProposal,
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  type ReviewMemoryOwner,
} from './db';

const REVIEW_MEMORY_SECTION_HEADING = '## Review memory';
const REVIEW_MEMORY_CHANGE_REQUEST_TITLE = 'docs(review): update REVIEW.md guidance';
const REVIEW_MEMORY_CHANGE_REQUEST_MARKER = '<!-- kilo-review-memory-change-request -->';
const APPROVABLE_STATUSES = new Set(['open', 'edited', 'change_request_failed']);

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

  if (proposal.change_request_url) {
    return proposal;
  }

  if (!APPROVABLE_STATUSES.has(proposal.status)) {
    throw new ReviewMemoryChangeRequestError(
      'CONFLICT',
      'Only open, edited, or failed Review Memory proposals can be approved.'
    );
  }

  assertReviewMemoryTargetPath(proposal.target_file_path);

  const integration = await resolveIntegrationForProposal(input.owner, proposal);
  const branchName = proposal.branch_name ?? `kilo/review-memory/${proposal.id.slice(0, 8)}`;
  const changeRequestType = changeRequestTypeForPlatform(proposal.platform);
  const openingProposal = await markProposalOpeningChangeRequest({
    owner: input.owner,
    proposalId: proposal.id,
    approvedByUserId: input.approvedByUser.id,
    changeRequestType,
    branchName,
  });

  if (!openingProposal) {
    throw new ReviewMemoryChangeRequestError('NOT_FOUND', 'Review memory proposal not found');
  }

  try {
    const result =
      proposal.platform === 'github'
        ? await openGitHubReviewMemoryPullRequest(openingProposal, integration)
        : await openGitLabReviewMemoryMergeRequest(openingProposal, integration);

    if (result.superseded) {
      return await markProposalSuperseded({ proposalId: proposal.id });
    }

    const opened = await markProposalChangeRequestOpened({
      proposalId: proposal.id,
      changeRequestNumber: result.number,
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
  const existingContent = await fetchGitHubRootTextFileAtRef({
    token: token.token,
    ...repo,
    path: proposal.target_file_path,
    ref: defaultBranch,
  });

  if (contentIncludesProposal(existingContent, proposal.proposed_markdown)) {
    return { superseded: true };
  }

  await createGitHubBranch({
    token: token.token,
    ...repo,
    branchName: requireBranchName(proposal),
    baseBranch: defaultBranch,
  });
  const branchContent = await fetchGitHubRootTextFileAtRef({
    token: token.token,
    ...repo,
    path: proposal.target_file_path,
    ref: requireBranchName(proposal),
  });
  if (!contentIncludesProposal(branchContent, proposal.proposed_markdown)) {
    await createOrUpdateGitHubRootTextFile({
      token: token.token,
      ...repo,
      path: proposal.target_file_path,
      branch: requireBranchName(proposal),
      message: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
      content: buildReviewMemoryFileContent(
        branchContent ?? existingContent,
        proposal.proposed_markdown
      ),
    });
  }
  const pullRequest = await createGitHubPullRequest({
    token: token.token,
    ...repo,
    title: REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
    body: buildChangeRequestBody(proposal, 'pull request'),
    headBranch: requireBranchName(proposal),
    baseBranch: defaultBranch,
  });

  return { superseded: false, ...pullRequest, label: 'GitHub PR' };
}

async function openGitLabReviewMemoryMergeRequest(
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
  const existingContent = await fetchGitLabRootTextFileAtRef(
    token,
    proposal.repo_full_name,
    proposal.target_file_path,
    defaultBranch,
    instanceUrl
  );

  if (contentIncludesProposal(existingContent, proposal.proposed_markdown)) {
    return { superseded: true };
  }

  await createGitLabBranch(
    token,
    projectId,
    requireBranchName(proposal),
    defaultBranch,
    instanceUrl
  );
  const branchContent = await fetchGitLabRootTextFileAtRef(
    token,
    proposal.repo_full_name,
    proposal.target_file_path,
    requireBranchName(proposal),
    instanceUrl
  );
  if (!contentIncludesProposal(branchContent, proposal.proposed_markdown)) {
    const fileExistsOnBranch = branchContent ?? existingContent;
    await createOrUpdateGitLabTextFile(
      token,
      projectId,
      requireBranchName(proposal),
      proposal.target_file_path,
      buildReviewMemoryFileContent(fileExistsOnBranch, proposal.proposed_markdown),
      REVIEW_MEMORY_CHANGE_REQUEST_TITLE,
      fileExistsOnBranch ? 'update' : 'create',
      instanceUrl
    );
  }
  const mergeRequest = await createGitLabMergeRequest(
    token,
    projectId,
    requireBranchName(proposal),
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
  if (proposal.platform_integration_id) {
    const integration = await getIntegrationById(proposal.platform_integration_id);
    if (integration && integrationMatchesOwner(integration, owner)) {
      return integration;
    }
  }

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

function integrationMatchesOwner(
  integration: PlatformIntegration,
  owner: ReviewMemoryOwner
): boolean {
  return owner.type === 'org'
    ? integration.owned_by_organization_id === owner.id
    : integration.owned_by_user_id === owner.id;
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

function changeRequestTypeForPlatform(platform: string): ReviewMemoryChangeRequestType {
  return platform === PLATFORM.GITLAB ? 'gitlab_mr' : 'github_pr';
}

function splitGitHubRepository(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repoFullName.split('/');
  if (!owner || !repo || extra) {
    throw new Error('GitHub repository names must use the owner/repo format.');
  }
  return { owner, repo };
}

function assertReviewMemoryTargetPath(path: string): void {
  if (path !== 'REVIEW.md') {
    throw new ReviewMemoryChangeRequestError(
      'BAD_REQUEST',
      'Review Memory can only open change requests for REVIEW.md.'
    );
  }
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

function gitLabInstanceUrl(metadata: unknown): string {
  const record = objectRecord(metadata);
  const instanceUrl = record?.gitlab_instance_url;
  return typeof instanceUrl === 'string' && instanceUrl ? instanceUrl : 'https://gitlab.com';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireBranchName(proposal: CodeReviewMemoryProposal): string {
  if (!proposal.branch_name) {
    throw new Error('Review Memory proposal is missing its change request branch name.');
  }
  return proposal.branch_name;
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

export function buildReviewMemoryFileContent(
  existingContent: string | null,
  proposedMarkdown: string
): string {
  const proposal = normalizeMarkdown(proposedMarkdown);
  const existing = normalizeMarkdown(existingContent ?? '');
  if (!existing) {
    return `${REVIEW_MEMORY_SECTION_HEADING}\n\n${proposal}\n`;
  }

  const lines = existing.split('\n');
  const headingIndex = lines.findIndex(
    line => line.trim().toLowerCase() === REVIEW_MEMORY_SECTION_HEADING.toLowerCase()
  );
  if (headingIndex === -1) {
    return `${existing}\n\n${REVIEW_MEMORY_SECTION_HEADING}\n\n${proposal}\n`;
  }

  const nextSectionIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^##\s+\S/.test(line.trim())
  );
  const insertAt = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
  const before = lines.slice(0, insertAt).join('\n').trimEnd();
  const after = lines.slice(insertAt).join('\n').trimStart();
  if (!after) {
    return `${before}\n\n${proposal}\n`;
  }
  return `${before}\n\n${proposal}\n\n${after}\n`;
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
