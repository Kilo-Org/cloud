import { resolveMergeRequestCheckoutRef } from '@/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-checkout-ref';

describe('resolveMergeRequestCheckoutRef', () => {
  it('uses source_branch for same-project MRs', () => {
    const result = resolveMergeRequestCheckoutRef({
      object_attributes: {
        iid: 42,
        source_branch: 'feature/same-project',
        source_project_id: 100,
        target_project_id: 100,
      },
    });

    expect(result).toEqual({
      checkoutRef: 'feature/same-project',
      isForkMr: false,
    });
  });

  it('uses refs/merge-requests/<iid>/head for fork MRs', () => {
    const result = resolveMergeRequestCheckoutRef({
      object_attributes: {
        iid: 99,
        source_branch: 'bugfixes',
        source_project_id: 200,
        target_project_id: 100,
      },
    });

    expect(result).toEqual({
      checkoutRef: 'refs/merge-requests/99/head',
      isForkMr: true,
    });
  });
});
