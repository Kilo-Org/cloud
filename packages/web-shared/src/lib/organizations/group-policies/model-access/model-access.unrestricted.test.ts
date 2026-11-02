import { describe, expect, it } from '@jest/globals';

// Both follow-up lookups are forced to throw: the unrestricted grant must return
// before either of them, while a restricted grant must still reach them.
jest.mock('@kilocode/web-shared/lib/model-allow.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/model-allow.server'),
  isModelRestrictionExempt: async () => {
    throw new Error('resolved model exemptions');
  },
  getModelInferenceProviders: async () => {
    throw new Error('resolved pinned providers');
  },
}));

import type { OrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import {
  evaluateEffectiveModelAccessPolicy,
  getEffectiveModelDecision,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

function context(
  overrides: Partial<OrganizationGroupPolicyContext> = {}
): OrganizationGroupPolicyContext {
  return {
    organization: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Unrestricted lookups',
      created_at: '',
      updated_at: '',
      microdollars_used: 0,
      microdollars_balance: 0,
      total_microdollars_acquired: 0,
      next_credit_expiration_at: null,
      stripe_customer_id: null,
      auto_top_up_enabled: false,
      settings: {},
      seat_count: 0,
      require_seats: false,
      created_by_kilo_user_id: null,
      deleted_at: null,
      sso_domain: null,
      parent_organization_id: null,
      plan: 'teams',
      free_trial_end_at: null,
      company_domain: null,
    },
    defaultPolicies: [],
    groupIds: [],
    groupPolicies: [],
    policyRevision: 1,
    ...overrides,
  };
}

const unreachableSnapshotLookup = async () => {
  throw new Error('resolved snapshot providers');
};

describe('unrestricted model access decisions', () => {
  it('admits every model without resolving exemptions, pins or snapshot providers', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(context());
    expect(policy.memberGrant).toEqual({ mode: 'unrestricted' });
    expect(policy.requireModelInCurrentSnapshot).toBe(false);

    await expect(
      getEffectiveModelDecision(policy, 'acme/any-model', unreachableSnapshotLookup)
    ).resolves.toEqual({ allowed: true });
    await expect(
      getEffectiveModelDecision(policy, 'acme/any-model:free', unreachableSnapshotLookup)
    ).resolves.toEqual({ allowed: true });
  });

  it('still resolves exemptions and pins for a restricted grant', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: { ...context().organization, plan: 'enterprise' },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );
    expect(policy.memberGrant).toEqual({ mode: 'organization_baseline' });

    await expect(
      getEffectiveModelDecision(policy, 'acme/any-model', unreachableSnapshotLookup)
    ).rejects.toThrow('resolved model exemptions');
  });
});
