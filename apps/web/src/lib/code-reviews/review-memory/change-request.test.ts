/* eslint-disable drizzle/enforce-delete-with-where */
const mockGenerateGitHubInstallationToken = jest.fn();
const mockFetchGitHubRepositoryDefaultBranch = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockCreateGitHubBranch = jest.fn();
const mockCreateOrUpdateGitHubRootTextFile = jest.fn();
const mockCreateGitHubPullRequest = jest.fn();
const mockFetchGitLabProjectDetails = jest.fn();
const mockFetchGitLabRootTextFileAtRef = jest.fn();
const mockCreateGitLabBranch = jest.fn();
const mockCreateOrUpdateGitLabTextFile = jest.fn();
const mockCreateGitLabMergeRequest = jest.fn();
const mockGetStoredProjectAccessToken = jest.fn();
const mockGetValidGitLabToken = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
  fetchGitHubRepositoryDefaultBranch: (...args: unknown[]) =>
    mockFetchGitHubRepositoryDefaultBranch(...args),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockFetchGitHubRootTextFileAtRef(...args),
  createGitHubBranch: (...args: unknown[]) => mockCreateGitHubBranch(...args),
  createOrUpdateGitHubRootTextFile: (...args: unknown[]) =>
    mockCreateOrUpdateGitHubRootTextFile(...args),
  createGitHubPullRequest: (...args: unknown[]) => mockCreateGitHubPullRequest(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabProjectDetails: (...args: unknown[]) => mockFetchGitLabProjectDetails(...args),
  fetchGitLabRootTextFileAtRef: (...args: unknown[]) => mockFetchGitLabRootTextFileAtRef(...args),
  createGitLabBranch: (...args: unknown[]) => mockCreateGitLabBranch(...args),
  createOrUpdateGitLabTextFile: (...args: unknown[]) => mockCreateOrUpdateGitLabTextFile(...args),
  createGitLabMergeRequest: (...args: unknown[]) => mockCreateGitLabMergeRequest(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getStoredProjectAccessToken: (...args: unknown[]) => mockGetStoredProjectAccessToken(...args),
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_memory_proposals,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  approveAndOpenReviewMemoryChangeRequest,
  buildReviewMemoryFileContent,
} from './change-request';
import { upsertReviewMemoryProposal, type ReviewMemoryOwner } from './db';

describe('review memory change requests', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateGitHubInstallationToken.mockResolvedValue({
      token: 'github-token',
      expires_at: null,
    });
    mockFetchGitHubRepositoryDefaultBranch.mockResolvedValue('main');
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue('# Existing review guidance\n');
    mockCreateGitHubBranch.mockResolvedValue(undefined);
    mockCreateOrUpdateGitHubRootTextFile.mockResolvedValue(undefined);
    mockCreateGitHubPullRequest.mockResolvedValue({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
    });
    mockFetchGitLabProjectDetails.mockResolvedValue({ default_branch: 'main' });
    mockFetchGitLabRootTextFileAtRef.mockResolvedValue(null);
    mockCreateGitLabBranch.mockResolvedValue(undefined);
    mockCreateOrUpdateGitLabTextFile.mockResolvedValue(undefined);
    mockCreateGitLabMergeRequest.mockResolvedValue({
      number: 5,
      url: 'https://gitlab.example.com/group/project/-/merge_requests/5',
    });
    mockGetStoredProjectAccessToken.mockReturnValue(null);
    mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
  });

  async function seedGitHubIntegration(owner: ReviewMemoryOwner) {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '123',
        permissions: { contents: 'write', pull_requests: 'write' },
        repository_access: 'all',
        integration_status: 'active',
        github_app_type: 'standard',
      })
      .returning();
    return integration;
  }

  async function seedGitLabIntegration(owner: ReviewMemoryOwner) {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: 'gitlab',
        integration_type: 'oauth',
        repository_access: 'all',
        integration_status: 'active',
        metadata: {
          access_token: 'oauth-token',
          gitlab_instance_url: 'https://gitlab.example.com',
        },
      })
      .returning();
    return integration;
  }

  async function markProposalFailedWithStaleUrl(proposalId: string) {
    await db
      .update(code_review_memory_proposals)
      .set({
        status: 'change_request_failed',
        change_request_url: 'https://example.com/stale-change-request',
      })
      .where(eq(code_review_memory_proposals.id, proposalId));
  }

  it('opens a GitHub pull request for an approved proposal', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitHubIntegration(owner);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Clarify widget guidance',
      rationale: 'Maintainers corrected repeated widget comments.',
      proposedMarkdown: '### Clarify widget guidance\n\nAvoid flagging intentional widgets.',
      dedupeKey: 'github-clarify-widget',
    });

    const opened = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
    });
    const branchName = `kilo/review-memory/${proposal.id.slice(0, 8)}`;

    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/7',
      })
    );
    expect(mockCreateGitHubBranch).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main', branchName })
    );
    expect(mockCreateOrUpdateGitHubRootTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: branchName,
        content: expect.stringContaining('### Clarify widget guidance'),
      })
    );
  });

  it('marks proposals superseded when REVIEW.md already includes the draft', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitHubIntegration(owner);
    const proposedMarkdown = '### Existing guidance\n\nAvoid duplicate changes.';
    mockFetchGitHubRootTextFileAtRef.mockResolvedValueOnce(`# Existing\n\n${proposedMarkdown}\n`);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Existing guidance',
      rationale: 'The guidance already exists.',
      proposedMarkdown,
      dedupeKey: 'github-existing-guidance',
    });

    const result = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
    });

    expect(result.status).toBe('superseded');
    expect(mockCreateGitHubBranch).not.toHaveBeenCalled();
    expect(mockCreateGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('opens a GitLab merge request for an approved proposal', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitLabIntegration(owner);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'gitlab',
      repoFullName: 'group/project',
      platformProjectId: 123,
      scopeKind: 'repository',
      proposalType: 'narrow',
      title: 'Narrow generated file guidance',
      rationale: 'Maintainers resolved repeated generated file comments.',
      proposedMarkdown: '### Generated files\n\nSkip generated fixtures unless behavior changes.',
      dedupeKey: 'gitlab-narrow-generated-files',
    });

    const opened = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
    });
    const branchName = `kilo/review-memory/${proposal.id.slice(0, 8)}`;

    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://gitlab.example.com/group/project/-/merge_requests/5',
      })
    );
    expect(mockCreateGitLabBranch).toHaveBeenCalledWith(
      'gitlab-token',
      123,
      branchName,
      'main',
      'https://gitlab.example.com'
    );
    expect(mockCreateOrUpdateGitLabTextFile).toHaveBeenCalledWith(
      'gitlab-token',
      123,
      branchName,
      'REVIEW.md',
      expect.stringContaining('### Generated files'),
      'docs(review): update REVIEW.md guidance',
      'create',
      'https://gitlab.example.com'
    );
  });

  it('records a failed status when external creation fails', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitHubIntegration(owner);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Failing proposal',
      rationale: 'The external API fails.',
      proposedMarkdown: '### Failure\n\nThis should fail.',
      dedupeKey: 'github-failing-proposal',
    });
    mockCreateGitHubPullRequest.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      approveAndOpenReviewMemoryChangeRequest({
        owner,
        proposalId: proposal.id,
        approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
      })
    ).rejects.toThrow('GitHub unavailable');

    const [failed] = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(failed).toEqual(
      expect.objectContaining({
        status: 'change_request_failed',
      })
    );
  });

  it('retries failed proposals with stale change request URLs', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitHubIntegration(owner);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Retry stale URL proposal',
      rationale: 'The previous change request failed after storing a URL.',
      proposedMarkdown: '### Retry stale URL\n\nTry opening this again.',
      dedupeKey: 'github-retry-stale-url',
    });
    await markProposalFailedWithStaleUrl(proposal.id);

    const opened = await approveAndOpenReviewMemoryChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
    });

    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/7',
      })
    );
    expect(mockCreateGitHubPullRequest).toHaveBeenCalledTimes(1);
  });

  it('clears stale change request URLs when retrying fails', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedGitHubIntegration(owner);
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Retry failure proposal',
      rationale: 'The retry should not keep the stale URL.',
      proposedMarkdown: '### Retry failure\n\nClear stale URLs.',
      dedupeKey: 'github-retry-failure-clears-url',
    });
    await markProposalFailedWithStaleUrl(proposal.id);
    mockCreateGitHubPullRequest.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      approveAndOpenReviewMemoryChangeRequest({
        owner,
        proposalId: proposal.id,
        approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
      })
    ).rejects.toThrow('GitHub unavailable');

    const [failed] = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));
    expect(failed).toEqual(
      expect.objectContaining({
        status: 'change_request_failed',
        change_request_url: null,
      })
    );
  });

  it('rejects malformed GitLab integration metadata instead of defaulting hosts', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const integration = await seedGitLabIntegration(owner);
    await db
      .update(platform_integrations)
      .set({ metadata: { gitlab_instance_url: 42 } })
      .where(eq(platform_integrations.id, integration.id));
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'gitlab',
      repoFullName: 'group/project',
      platformProjectId: 123,
      scopeKind: 'repository',
      proposalType: 'narrow',
      title: 'Malformed metadata proposal',
      rationale: 'The integration metadata is invalid.',
      proposedMarkdown: '### Metadata\n\nDo not default malformed hosts.',
      dedupeKey: 'gitlab-malformed-metadata',
    });

    await expect(
      approveAndOpenReviewMemoryChangeRequest({
        owner,
        proposalId: proposal.id,
        approvedByUser: { id: user.id, email: user.google_user_email, name: user.google_user_name },
      })
    ).rejects.toThrow('GitLab integration metadata is malformed');

    expect(mockFetchGitLabProjectDetails).not.toHaveBeenCalled();
  });

  it('inserts proposal markdown under an existing Review memory section', () => {
    expect(
      buildReviewMemoryFileContent(
        '# REVIEW\n\n## Review memory\n\nExisting item.\n\n## Other guidance\n\nKeep this.',
        '### New item\n\nAvoid noisy comments.'
      )
    ).toBe(
      '# REVIEW\n\n## Review memory\n\nExisting item.\n\n### New item\n\nAvoid noisy comments.\n\n## Other guidance\n\nKeep this.\n'
    );
  });
});
