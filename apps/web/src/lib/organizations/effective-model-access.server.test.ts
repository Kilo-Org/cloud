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

const currentSnapshotLookup = async (modelId: string) =>
  new Set(
    {
      'anthropic/claude': ['anthropic'],
      'openai/gpt-4o': ['openai'],
      'openai/o3': ['openai'],
    }[modelId] ?? []
  );

describe('effective organization model access', () => {
  it('preserves current organization access outside Enterprise', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: { ...context().organization, plan: 'teams' },
        defaultPolicies: [],
      })
    );
    expect(
      (await getEffectiveModelDecision(policy, 'anthropic/claude', async () => new Set())).allowed
    ).toBe(true);
  });

  it('denies Enterprise model aliases missing from the current snapshot', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: { model_deny_list: ['x-ai/grok-4.5'] },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );

    const decision = await getEffectiveModelDecision(policy, 'grok-4.5', async () => new Set());

    expect(decision).toEqual({ allowed: false, denialSource: 'organization_model' });
  });

  it.each(['kilo-auto/balanced', 'kilo-internal/private-model', 'kimi-coding/kimi-for-coding'])(
    'keeps %s exempt from effective Enterprise restrictions',
    async modelId => {
      const policy = evaluateEffectiveModelAccessPolicy(context());

      await expect(
        getEffectiveModelDecision(policy, modelId, async () => new Set())
      ).resolves.toEqual({ allowed: true });
    }
  );

  it('preserves organization access when no model access policy is configured', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ defaultPolicies: [], groupPolicies: [] })
    );
    expect(
      (await getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)).allowed
    ).toBe(true);
    expect((await getEffectiveModelDecision(policy, 'openai/o3')).allowed).toBe(false);
  });

  it('normalizes model suffixes before applying organization restrictions', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }] })
    );

    expect((await getEffectiveModelDecision(policy, 'openai/o3:free')).allowed).toBe(false);
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
    expect(
      (await getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)).allowed
    ).toBe(true);
    expect(
      (await getEffectiveModelDecision(policy, 'openai/gpt-4o', currentSnapshotLookup)).allowed
    ).toBe(false);
  });

  it('lets all dominate selected and none within the organization ceiling', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ groupPolicies: [[{ type: 'model_access', data: { mode: 'all' } }]] })
    );
    expect(
      (await getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)).allowed
    ).toBe(true);
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
    expect(decision).toMatchObject({ allowed: false, denialSource: 'organization_model' });
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
