import { resolvePullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';

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
