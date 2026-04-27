import { resolvePullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';
import { shouldSkipSynchronizeForMergeCommit } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler';

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
