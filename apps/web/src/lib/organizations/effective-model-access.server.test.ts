import { describe, expect, it } from '@jest/globals';
import type { OrganizationGroupPolicyContext } from './organization-group-policy-context.server';
import {
  evaluateEffectiveModelAccessPolicy,
  getEffectiveModelDecision,
} from './effective-model-access.server';
import { CLAUDE_SONNET_LATEST_MODEL_ALIAS } from '@/lib/ai-gateway/latest-model-aliases';

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
    groupIds: [],
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

  it('requires snapshot membership for Enterprise without configured restrictions', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: { ...context().organization, settings: {} },
        defaultPolicies: [],
      })
    );

    await expect(
      getEffectiveModelDecision(policy, 'grok-4.5', async () => new Set())
    ).resolves.toEqual({ allowed: false, denialSource: 'organization_model' });
    await expect(
      getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)
    ).resolves.toEqual({ allowed: true });
  });

  it('applies organization model restrictions to latest aliases', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: {
            model_deny_list: [CLAUDE_SONNET_LATEST_MODEL_ALIAS],
            provider_allow_list: ['anthropic'],
          },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );

    await expect(
      getEffectiveModelDecision(policy, CLAUDE_SONNET_LATEST_MODEL_ALIAS, async () => {
        throw new Error('denied models must not use snapshot provider metadata');
      })
    ).resolves.toEqual({ allowed: false, denialSource: 'organization_model' });
  });

  it('requires latest aliases to exist in the current snapshot', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: {
            model_deny_list: [],
            provider_allow_list: ['anthropic'],
          },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );

    await expect(
      getEffectiveModelDecision(policy, CLAUDE_SONNET_LATEST_MODEL_ALIAS, async () => new Set())
    ).resolves.toEqual({ allowed: false, denialSource: 'organization_model' });
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

  it('allows known snapshot models when no model access policy is configured', async () => {
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

  it('lets group all grant the complete organization baseline', async () => {
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

  it('allows provider grants beyond the organization baseline', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: { mode: 'selected', model_allow_list: [], provider_allow_list: ['google'] },
            },
          ],
        ],
      })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'shared/model',
      async () => new Set(['google', 'openai'])
    );
    expect(decision.allowed).toBe(true);
    expect([...decision.eligibleProviderRoutes!]).toEqual(['google', 'openai']);
  });

  it('allows selected model grants beyond the organization baseline', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: {
                mode: 'selected',
                model_allow_list: ['google/gemini'],
                provider_allow_list: [],
              },
            },
          ],
        ],
      })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'google/gemini',
      async () => new Set(['google'])
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('allows selected group models denied by the organization baseline', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
        groupPolicies: [
          [
            {
              type: 'model_access',
              data: {
                mode: 'selected',
                model_allow_list: ['openai/o3'],
                provider_allow_list: [],
              },
            },
          ],
        ],
      })
    );

    await expect(
      getEffectiveModelDecision(policy, 'openai/o3', currentSnapshotLookup)
    ).resolves.toEqual({ allowed: true });
    await expect(
      getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)
    ).resolves.toMatchObject({ allowed: true });
  });

  it('keeps organization restrictions as the baseline without an additive grant', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({ defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }] })
    );

    await expect(
      getEffectiveModelDecision(policy, 'google/gemini', async () => new Set(['google']))
    ).resolves.toEqual({ allowed: false, denialSource: 'organization_provider' });
    await expect(
      getEffectiveModelDecision(policy, 'openai/o3', currentSnapshotLookup)
    ).resolves.toEqual({ allowed: false, denialSource: 'organization_model' });
  });

  it('combines group all baseline access with selected grants from another group', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        defaultPolicies: [{ type: 'model_access', data: { mode: 'none' } }],
        groupPolicies: [
          [{ type: 'model_access', data: { mode: 'all' } }],
          [
            {
              type: 'model_access',
              data: {
                mode: 'selected',
                model_allow_list: ['google/gemini'],
                provider_allow_list: [],
              },
            },
          ],
        ],
      })
    );

    await expect(
      getEffectiveModelDecision(policy, 'anthropic/claude', currentSnapshotLookup)
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      getEffectiveModelDecision(policy, 'google/gemini', async () => new Set(['google']))
    ).resolves.toEqual({ allowed: true });
  });

  it('hides restricted exclusive models when every restricted provider is disabled', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: { provider_allow_list: ['deepseek', 'fireworks'], model_deny_list: [] },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );
    const catalogLookup = async () => new Set(['fireworks', 'openai']);

    expect(
      await getEffectiveModelDecision(policy, 'openai/gpt-5.6-sol-discounted', catalogLookup)
    ).toEqual({ allowed: false, denialSource: 'organization_provider' });
  });

  it('keeps restricted exclusive models when a restricted provider remains enabled', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: { provider_allow_list: ['openai', 'fireworks'], model_deny_list: [] },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );
    const decision = await getEffectiveModelDecision(
      policy,
      'openai/gpt-5.6-sol-discounted',
      async () => new Set(['fireworks'])
    );

    expect(decision.allowed).toBe(true);
    expect([...decision.eligibleProviderRoutes!]).toEqual(['openai']);
  });

  it('does not apply exclusive restrictions to the unsuffixed catalog model', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: { provider_allow_list: ['fireworks'], model_deny_list: [] },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );
    const catalogLookup = async () => new Set(['fireworks', 'openai']);

    const exclusive = await getEffectiveModelDecision(
      policy,
      'openai/gpt-5.6-sol-discounted',
      catalogLookup
    );
    const catalogModel = await getEffectiveModelDecision(
      policy,
      'openai/gpt-5.6-sol',
      catalogLookup
    );

    expect(exclusive).toEqual({ allowed: false, denialSource: 'organization_provider' });
    expect(catalogModel.allowed).toBe(true);
    expect([...catalogModel.eligibleProviderRoutes!]).toEqual(['fireworks']);
  });

  it('still evaluates restricted exclusive models missing from the snapshot', async () => {
    const policy = evaluateEffectiveModelAccessPolicy(
      context({
        organization: {
          ...context().organization,
          settings: { provider_allow_list: ['openai'], model_deny_list: [] },
        },
        defaultPolicies: [{ type: 'model_access', data: { mode: 'all' } }],
      })
    );
    const emptySnapshot = async () => new Set<string>();

    const restricted = await getEffectiveModelDecision(
      policy,
      'openai/gpt-5.6-sol-discounted',
      emptySnapshot
    );
    const unrestricted = await getEffectiveModelDecision(policy, 'unknown/model', emptySnapshot);

    expect(restricted.allowed).toBe(true);
    expect([...restricted.eligibleProviderRoutes!]).toEqual(['openai']);
    expect(unrestricted).toEqual({ allowed: false, denialSource: 'organization_model' });
  });
});
