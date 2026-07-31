import { describe, expect, it } from '@jest/globals';
import type { OrganizationGroupPolicyContext } from './organization-group-policy-context.server';
import {
  evaluateEffectiveModelAccessPolicy,
  getEffectiveModelDecision,
} from './effective-model-access.server';

function context(
  overrides: Partial<OrganizationGroupPolicyContext> = {}
): OrganizationGroupPolicyContext {
  return {
    organization: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Test',
      created_at: '',
      updated_at: '',
      microdollars_used: 0,
      microdollars_balance: 0,
      total_microdollars_acquired: 0,
      next_credit_expiration_at: null,
      stripe_customer_id: null,
      auto_top_up_enabled: false,
      settings: { provider_allow_list: ['anthropic', 'openai'], model_deny_list: ['openai/o3'] },
      seat_count: 0,
      require_seats: false,
      created_by_kilo_user_id: null,
      deleted_at: null,
      sso_domain: null,
      parent_organization_id: null,
      plan: 'enterprise',
      free_trial_end_at: null,
      company_domain: null,
    },
    defaultPolicies: [{ type: 'model_access', data: { mode: 'none' } }],
    groupPolicies: [],
    policyRevision: 1,
    ...overrides,
  };
}

describe('effective organization model access', () => {
  it('preserves current organization access outside Enterprise', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: { ...context().organization, plan: 'teams' },
        defaultPolicies: [],
      })
    );
    expect((await getEffectiveModelDecision(policy, 'anthropic/claude')).allowed).toBe(true);
  });

  it('preserves organization access when no model access policy is configured', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ defaultPolicies: [], groupPolicies: [] })
    );
    expect((await getEffectiveModelDecision(policy, 'anthropic/claude')).allowed).toBe(true);
    expect((await getEffectiveModelDecision(policy, 'openai/o3')).allowed).toBe(false);
  });

  it('requires an explicit none policy to grant no models', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(context());
    expect((await getEffectiveModelDecision(policy, 'anthropic/claude')).allowed).toBe(false);
  });

  it('unions selected model grants across groups', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: {
                mode: 'selected',
                model_allow_list: ['anthropic/claude'],
                provider_allow_list: [],
              },
            },
          ],
        ],
      })
    );
    expect((await getEffectiveModelDecision(policy, 'anthropic/claude')).allowed).toBe(true);
    expect((await getEffectiveModelDecision(policy, 'openai/gpt-4o')).allowed).toBe(false);
  });

  it('lets all dominate selected and none within the organization ceiling', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ groupPolicies: [[{ type: 'model_access', data: { mode: 'all' } }]] })
    );
    expect((await getEffectiveModelDecision(policy, 'anthropic/claude')).allowed).toBe(true);
    expect((await getEffectiveModelDecision(policy, 'openai/o3')).allowed).toBe(false);
  });

  it('fails closed when a provider-derived grant has no metadata', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: { mode: 'selected', model_allow_list: [], provider_allow_list: ['anthropic'] },
            },
          ],
        ],
      })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'unknown/model',
      async () => new Set()
    );
    expect(decision).toMatchObject({ allowed: false, denialSource: 'group_provider' });
  });

  it('intersects provider-derived grants with the organization ceiling', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: { mode: 'selected', model_allow_list: [], provider_allow_list: ['anthropic'] },
            },
          ],
        ],
      })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'shared/model',
      async () => new Set(['anthropic', 'openai'])
    );
    expect(decision.allowed).toBe(true);
    expect([...decision.eligibleProviderRoutes!]).toEqual(['anthropic']);
  });

  it('denies models with no route inside the organization provider ceiling', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ groupPolicies: [[{ type: 'model_access', data: { mode: 'all' } }]] })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'google/gemini',
      async () => new Set(['google'])
    );
    expect(decision).toEqual({ allowed: false, denialSource: 'organization_provider' });
  });
});
