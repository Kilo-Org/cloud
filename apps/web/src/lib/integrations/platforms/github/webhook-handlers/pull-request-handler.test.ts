const mockGetBotUserId = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (organizationId: string, botType: string) =>
    mockGetBotUserId(organizationId, botType),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (owner: unknown, agentType: string, platform: string) =>
    mockGetAgentConfigForOwner(owner, agentType, platform),
}));

import { resolvePullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';
import {
  handlePullRequest,
  shouldSkipSynchronizeForMergeCommit,
} from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import type { PlatformIntegration } from '@kilocode/db/schema';

function pullRequestPayload(overrides: Partial<PullRequestPayload> = {}): PullRequestPayload {
  return {
    action: 'synchronize',
    installation: { id: 98765 },
    repository: {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 42,
      title: 'Add widgets',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { id: 111, login: 'alice', avatar_url: 'https://example.com/a.png' },
      head: { sha: 'abc123', ref: 'feature/widgets', repo: { full_name: 'acme/widgets' } },
      base: { sha: 'def456', ref: 'main' },
    },
    ...overrides,
  };
}

function platformIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: '8b2ff443-8396-4b07-99ae-7015789da7dd',
    owned_by_organization_id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
    owned_by_user_id: null,
    kilo_requester_user_id: null,
    platform_installation_id: '98765',
    github_app_type: 'standard',
    ...overrides,
  } as PlatformIntegration;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBotUserId.mockResolvedValue(null);
  mockGetAgentConfigForOwner.mockResolvedValue(null);
});

describe('resolvePullRequestCheckoutRef', () => {
  it('uses head.ref for same-repo PRs', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 123,
        head: {
          ref: 'feature/same-repo',
          repo: { full_name: 'acme/widgets' },
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'feature/same-repo',
      isForkPr: false,
      headRepoFullName: 'acme/widgets',
    });
  });

  it('uses refs/pull/<number>/head for fork PRs', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 456,
        head: {
          ref: 'feature/fork-branch',
          repo: { full_name: 'external/widgets-fork' },
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'refs/pull/456/head',
      isForkPr: true,
      headRepoFullName: 'external/widgets-fork',
    });
  });

  it('falls back to head.ref when head.repo is missing', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 789,
        head: {
          ref: 'feature/missing-head-repo',
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'feature/missing-head-repo',
      isForkPr: false,
      headRepoFullName: null,
    });
  });
});

describe('shouldSkipSynchronizeForMergeCommit', () => {
  const baseArgs = {
    installationId: 'inst-1',
    headOwner: 'acme',
    headRepoName: 'widgets',
    headSha: 'deadbeef',
    appType: 'standard' as const,
  };

  it('returns false for non-synchronize actions without calling the check', async () => {
    for (const action of ['opened', 'reopened', 'ready_for_review']) {
      let called = false;
      const result = await shouldSkipSynchronizeForMergeCommit({
        ...baseArgs,
        action,
        isMergeCommitFn: async () => {
          called = true;
          return true;
        },
      });

      expect(result).toBe(false);
      expect(called).toBe(false);
    }
  });

  it('returns true when synchronize head is a merge commit', async () => {
    const result = await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async () => true,
    });

    expect(result).toBe(true);
  });

  it('returns false when synchronize head is not a merge commit', async () => {
    const result = await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async () => false,
    });

    expect(result).toBe(false);
  });

  it('passes the expected arguments to the check function', async () => {
    const calls: Array<[string, string, string, string, string]> = [];
    await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async (installationId, owner, repo, sha, appType) => {
        calls.push([installationId, owner, repo, sha, appType]);
        return false;
      },
    });

    expect(calls).toEqual([['inst-1', 'acme', 'widgets', 'deadbeef', 'standard']]);
  });
});

describe('handlePullRequest', () => {
  it('acknowledges org integrations that do not have a code review user context', async () => {
    const response = await handlePullRequest(pullRequestPayload(), platformIntegration());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Code review user context not configured' });
    expect(mockGetBotUserId).toHaveBeenCalledWith(
      'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
      'code-review'
    );
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
  });
});
