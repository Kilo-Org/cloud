/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, inArray } from 'drizzle-orm';
import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-review';
import {
  code_review_memory_proposals,
  kilocode_users,
  platform_integrations,
  type CodeReviewMemoryProposal,
} from '@kilocode/db/schema';

import {
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  upsertScopeProposal,
  type ReviewMemoryOwner,
} from './db';
import {
  approveAndOpenReviewMemoryChangeRequest,
  buildChangeRequestBody,
  isStaleOpeningChangeRequest,
} from './change-request';

const mockCreateGitHubBranch = jest.fn();
const mockCreateGitHubPullRequest = jest.fn();
const mockCreateOrUpdateGitHubRootTextFile = jest.fn();
const mockFetchGitHubRepositoryDefaultBranch = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockFetchGitHubPullRequestForHeadBranch = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();
const mockGenerateIntegratedReviewGuidanceWithGateway = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  createGitHubBranch: (...args: unknown[]) => mockCreateGitHubBranch(...args),
  createGitHubPullRequest: (...args: unknown[]) => mockCreateGitHubPullRequest(...args),
  createOrUpdateGitHubRootTextFile: (...args: unknown[]) =>
    mockCreateOrUpdateGitHubRootTextFile(...args),
  fetchGitHubRepositoryDefaultBranch: (...args: unknown[]) =>
    mockFetchGitHubRepositoryDefaultBranch(...args),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockFetchGitHubRootTextFileAtRef(...args),
  fetchGitHubPullRequestForHeadBranch: (...args: unknown[]) =>
    mockFetchGitHubPullRequestForHeadBranch(...args),
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));

jest.mock('./review-md-integration', () => ({
  generateIntegratedReviewGuidanceWithGateway: (...args: unknown[]) =>
    mockGenerateIntegratedReviewGuidanceWithGateway(...args),
}));

const integrationIds: string[] = [];

describe('review memory change requests', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await db.delete(code_review_memory_proposals);
    await db.delete(kilocode_users);
    if (integrationIds.length > 0) {
      await db
        .delete(platform_integrations)
        .where(inArray(platform_integrations.id, integrationIds.splice(0)));
    }
  });

  it('builds a change-request body with the marker and proposal sections', async () => {
    const proposal = buildProposal({
      id: 'proposal-id',
      title: 'Generated fixtures',
      rationale: 'Maintainers corrected repeated generated fixture comments.',
    });

    expect(buildChangeRequestBody(proposal)).toContain(
      '<!-- kilo-review-memory-change-request -->'
    );
    expect(buildChangeRequestBody(proposal)).toContain('## Proposal');
    expect(buildChangeRequestBody(proposal)).toContain('Generated fixtures');
    expect(buildChangeRequestBody(proposal)).toContain('## Rationale');
  });

  it('applies guarded proposal status transitions', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    const openedProposal = await seedProposal(owner, 'acme/opened');
    const opening = await markProposalOpeningChangeRequest({ proposalId: openedProposal.id });
    expect(opening?.status).toBe('opening_change_request');
    const opened = await markProposalChangeRequestOpened({
      proposalId: openedProposal.id,
      changeRequestUrl: 'https://github.com/acme/opened/pull/1',
    });
    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/opened/pull/1',
      })
    );

    const failedProposal = await seedProposal(owner, 'acme/failed');
    await markProposalOpeningChangeRequest({ proposalId: failedProposal.id });
    const failed = await markProposalChangeRequestFailed({ proposalId: failedProposal.id });
    expect(failed?.status).toBe('change_request_failed');

    const supersededProposal = await seedProposal(owner, 'acme/superseded');
    const superseded = await markProposalSuperseded({ proposalId: supersededProposal.id });
    expect(superseded?.status).toBe('superseded');
  });

  it('detects stale opening change-request states', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    expect(isStaleOpeningChangeRequest('2026-06-01T11:31:00.000Z', now)).toBe(false);
    expect(isStaleOpeningChangeRequest('2026-06-01T11:30:00.000Z', now)).toBe(true);
    expect(isStaleOpeningChangeRequest('not-a-date', now)).toBe(false);
  });

  it('refuses approval with the shared sentence when the GitHub App lacks write access', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        github_connection_role: 'workflow',
        integration_type: 'app',
        platform_installation_id: '424242',
        github_app_type: 'standard',
        integration_status: 'active',
        repository_access: 'all',
        permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      })
      .returning();
    integrationIds.push(integration.id);
    const proposal = await seedProposal(owner, 'acme/widgets');

    await expect(
      approveAndOpenReviewMemoryChangeRequest({ owner, proposalId: proposal.id })
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ReviewMemoryChangeRequestError',
        code: 'BAD_REQUEST',
        reason: 'missing_github_app_permissions',
        message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.missing_github_app_permissions,
      })
    );
    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(stored[0]?.status).toBe('open');
  });

  it('refuses approval of a proposal that is no longer actionable', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner, 'acme/widgets');
    await db
      .update(code_review_memory_proposals)
      .set({ status: 'rejected' })
      .where(eq(code_review_memory_proposals.id, proposal.id));

    await expect(
      approveAndOpenReviewMemoryChangeRequest({ owner, proposalId: proposal.id })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        reason: 'proposal_not_actionable',
        message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_actionable,
      })
    );
  });

  it('reports a missing proposal by reason rather than by a status sentence', async () => {
    const user = await insertTestUser();

    await expect(
      approveAndOpenReviewMemoryChangeRequest({
        owner: { type: 'user', id: user.id },
        proposalId: '00000000-0000-4000-8000-00000000dead',
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'NOT_FOUND',
        reason: 'proposal_not_found',
        message: REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_found,
      })
    );
  });

  it('resumes a retry on an existing change-request pull request', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await insertWorkflowIntegration(user.id);
    const proposal = await seedProposal(owner, 'acme/widgets');
    mockGenerateGitHubInstallationToken.mockResolvedValue({
      token: 'test-token',
      expires_at: null,
    });
    mockFetchGitHubPullRequestForHeadBranch.mockResolvedValue({
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
    });

    const result = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/12',
      })
    );
    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(stored[0]?.status).toBe('change_request_opened');
    expect(stored[0]?.change_request_url).toBe('https://github.com/acme/widgets/pull/12');

    expect(mockFetchGitHubPullRequestForHeadBranch).toHaveBeenCalledWith({
      token: 'test-token',
      owner: 'acme',
      repo: 'widgets',
      headBranch: `kilo/review-memory/${proposal.id.slice(0, 8)}`,
    });
    expect(mockCreateGitHubBranch).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateGitHubRootTextFile).not.toHaveBeenCalled();
    expect(mockCreateGitHubPullRequest).not.toHaveBeenCalled();
    expect(mockFetchGitHubRepositoryDefaultBranch).not.toHaveBeenCalled();
    expect(mockFetchGitHubRootTextFileAtRef).not.toHaveBeenCalled();
    expect(mockGenerateIntegratedReviewGuidanceWithGateway).not.toHaveBeenCalled();
  });

  it('releases the proposal when a GitHub call times out', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await insertWorkflowIntegration(user.id);
    const proposal = await seedProposal(owner, 'acme/widgets');
    mockGenerateGitHubInstallationToken.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    );

    await expect(
      approveAndOpenReviewMemoryChangeRequest({ owner, proposalId: proposal.id })
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ReviewMemoryChangeRequestError',
        code: 'BAD_REQUEST',
        reason: 'change_request_failed',
      })
    );

    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(stored[0]?.status).toBe('change_request_failed');
    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith(
      '424242',
      'standard',
      expect.any(String),
      'workflow',
      expect.any(AbortSignal)
    );
  });

  it('opens a change request when no pull request exists yet', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await insertWorkflowIntegration(user.id);
    const proposal = await seedProposal(owner, 'acme/widgets');
    mockGenerateGitHubInstallationToken.mockResolvedValue({
      token: 'test-token',
      expires_at: null,
    });
    mockFetchGitHubPullRequestForHeadBranch.mockResolvedValue(null);
    mockFetchGitHubRepositoryDefaultBranch.mockResolvedValue('main');
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue(null);
    mockGenerateIntegratedReviewGuidanceWithGateway.mockResolvedValue({
      status: 'updated',
      updatedReviewMd: '# Guide',
      integrationSummary: 'ok',
    });
    mockCreateGitHubPullRequest.mockResolvedValue({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
    });

    const result = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
    });

    const branchName = `kilo/review-memory/${proposal.id.slice(0, 8)}`;
    expect(result.status).toBe('change_request_opened');
    expect(result.change_request_url).toBe('https://github.com/acme/widgets/pull/7');
    expect(mockCreateGitHubBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branchName, baseBranch: 'main' })
    );
    expect(mockCreateOrUpdateGitHubRootTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ branch: branchName, content: '# Guide' })
    );
    expect(mockCreateGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ headBranch: branchName, baseBranch: 'main' })
    );
    expect(mockGenerateIntegratedReviewGuidanceWithGateway).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    const stored = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(stored[0]?.status).toBe('change_request_opened');
    expect(stored[0]?.change_request_url).toBe('https://github.com/acme/widgets/pull/7');
  });
});

function buildProposal(input: {
  id: string;
  title: string;
  rationale: string;
}): CodeReviewMemoryProposal {
  return {
    id: input.id,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-id',
    platform: 'github',
    repo_full_name: 'acme/widgets',
    status: 'open',
    title: input.title,
    rationale: input.rationale,
    proposed_markdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [],
    positive_count: 0,
    negative_count: 0,
    neutral_count: 0,
    change_request_url: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

async function insertWorkflowIntegration(userId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'github',
      github_connection_role: 'workflow',
      integration_type: 'app',
      platform_installation_id: '424242',
      github_app_type: 'standard',
      integration_status: 'active',
      repository_access: 'all',
      permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
    })
    .returning();
  integrationIds.push(integration.id);
  return integration;
}

async function seedProposal(owner: ReviewMemoryOwner, repoFullName: string) {
  return await upsertScopeProposal({
    owner,
    platform: 'github',
    repoFullName,
    title: 'Generated fixtures',
    rationale: 'Maintainers corrected repeated generated fixture comments.',
    proposedMarkdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [{ excerpt: 'Generated fixture feedback.', prNumber: 10 }],
    positiveCount: 0,
    negativeCount: 1,
    neutralCount: 0,
  });
}
