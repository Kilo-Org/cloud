import { describe, expect, it } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OrganizationSettings,
} from '@kilocode/db/schema-types';

import {
  summarizeSubOrganizationModelPolicies,
  type OrganizationDefaultPolicyRow,
  type OrganizationGroupPolicyRow,
} from './model-policy';

const PARENT_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';

function organization(params: {
  id: string;
  plan?: Organization['plan'];
  settings?: OrganizationSettings;
  name?: string;
}): Organization {
  return {
    id: params.id,
    name: params.name ?? params.id,
    created_at: '',
    updated_at: '',
    microdollars_used: 0,
    microdollars_balance: 0,
    total_microdollars_acquired: 0,
    next_credit_expiration_at: null,
    stripe_customer_id: null,
    auto_top_up_enabled: false,
    settings: params.settings ?? {},
    seat_count: 0,
    require_seats: false,
    created_by_kilo_user_id: null,
    deleted_at: null,
    sso_domain: null,
    parent_organization_id: null,
    plan: params.plan ?? 'enterprise',
    free_trial_end_at: null,
    company_domain: null,
  };
}

function snapshot(
  providers: Array<{ slug: string; models: string[] }>
): NormalizedOpenRouterResponse {
  const normalizedProviders: NormalizedProvider[] = providers.map(provider => ({
    name: provider.slug,
    displayName: provider.slug,
    slug: provider.slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: provider.models.map(model => ({
      slug: model,
      name: model,
      author: provider.slug,
      description: '',
      context_length: 1,
      input_modalities: [],
      output_modalities: [],
      group: 'other',
      updated_at: '',
      endpoint: null,
    })),
  }));
  return {
    providers: normalizedProviders,
    total_providers: normalizedProviders.length,
    total_models: normalizedProviders.reduce(
      (total, provider) => total + provider.models.length,
      0
    ),
    generated_at: '2026-08-04T00:00:00Z',
  };
}

const CATALOG = snapshot([
  { slug: 'openai', models: ['shared/model', 'openai/only', 'openai/denied:free'] },
  { slug: 'anthropic', models: ['shared/model', 'anthropic/only'] },
  { slug: 'google', models: ['google/only'] },
]);

function defaults(
  organizationId: string,
  mode: 'all' | 'none' | 'selected',
  lists: { models?: string[]; providers?: string[] } = {}
): OrganizationDefaultPolicyRow {
  return {
    organizationId,
    policyRevision: 3,
    defaultPolicies: [
      mode === 'selected'
        ? {
            type: 'model_access',
            data: {
              mode,
              model_allow_list: lists.models ?? [],
              provider_allow_list: lists.providers ?? [],
            },
          }
        : { type: 'model_access', data: { mode } },
    ],
  };
}

async function summarize(params: {
  parent?: Organization;
  child?: Organization;
  defaultPolicyRows?: OrganizationDefaultPolicyRow[];
  groupRows?: OrganizationGroupPolicyRow[];
  catalog?: unknown | null;
}) {
  return await summarizeSubOrganizationModelPolicies({
    parent: params.parent ?? organization({ id: PARENT_ID }),
    children: [params.child ?? organization({ id: CHILD_ID })],
    defaultPolicyRows: params.defaultPolicyRows ?? [],
    groupRows: params.groupRows ?? [],
    catalogSnapshot: params.catalog === null ? null : { id: 42, data: params.catalog ?? CATALOG },
  });
}

describe('sub-organization model policy summary', () => {
  it('preserves configured restrictions separately from normalized effective restrictions', async () => {
    const result = await summarize({
      child: organization({
        id: CHILD_ID,
        settings: {
          provider_allow_list: [],
          model_deny_list: ['openai/denied:free', 'stale/model'],
        },
      }),
    });

    expect(result.children[0]?.organizationRestrictions).toEqual({
      enforcement: 'enforced',
      configured: {
        providerAllowList: [],
        modelDenyList: ['openai/denied:free', 'stale/model'],
      },
      effective: { providerAllowList: [], modelDenyList: ['openai/denied', 'stale/model'] },
    });
    expect(result.children[0]?.divergence?.organizationCeiling.models.parentOnly).toEqual([
      'anthropic/only',
      'google/only',
      'openai/denied',
      'openai/only',
      'shared/model',
    ]);
  });

  it('treats an absent provider ceiling as unrestricted and an empty ceiling as no routes', async () => {
    const result = await summarize({
      parent: organization({ id: PARENT_ID, settings: {} }),
      child: organization({ id: CHILD_ID, settings: { provider_allow_list: [] } }),
    });

    expect(result.parent.organizationRestrictions.configured.providerAllowList).toBeNull();
    expect(result.children[0]?.organizationRestrictions.configured.providerAllowList).toEqual([]);
    expect(result.children[0]?.divergence?.organizationCeiling.providers.parentOnly).toEqual([
      'anthropic',
      'google',
      'openai',
    ]);
  });

  it('keeps a shared model when one provider route remains eligible', async () => {
    const result = await summarize({
      parent: organization({ id: PARENT_ID, settings: { provider_allow_list: ['openai'] } }),
      child: organization({ id: CHILD_ID, settings: { provider_allow_list: ['anthropic'] } }),
    });

    expect(result.children[0]?.divergence?.organizationCeiling.models).toEqual({
      parentOnly: ['openai/denied', 'openai/only'],
      childOnly: ['anthropic/only'],
    });
  });

  it('does not remove an organization-ceiling provider when all its models are denied', async () => {
    const result = await summarize({
      child: organization({
        id: CHILD_ID,
        settings: {
          provider_allow_list: ['google'],
          model_deny_list: ['google/only'],
        },
      }),
    });

    expect(result.children[0]?.divergence?.organizationCeiling.providers).toEqual({
      parentOnly: ['anthropic', 'openai'],
      childOnly: [],
    });
    expect(result.children[0]?.divergence?.defaultAccess.providers).toEqual({
      parentOnly: ['anthropic', 'google', 'openai'],
      childOnly: [],
    });
  });

  it('makes stored organization and group restrictions inert on Teams', async () => {
    const result = await summarize({
      parent: organization({ id: PARENT_ID, plan: 'teams' }),
      child: organization({
        id: CHILD_ID,
        plan: 'teams',
        settings: {
          provider_allow_list: [],
          model_deny_list: ['shared/model'],
          data_collection: 'deny',
        },
      }),
      defaultPolicyRows: [defaults(CHILD_ID, 'none')],
      groupRows: [
        {
          organizationId: CHILD_ID,
          groupId: '00000000-0000-4000-8000-000000000003',
          groupName: 'Restricted',
          policies: [{ type: 'model_access', data: { mode: 'none' } }],
        },
      ],
    });

    const child = result.children[0];
    expect(child?.organizationRestrictions).toMatchObject({
      enforcement: 'inactive_plan',
      configured: { providerAllowList: [], modelDenyList: ['shared/model'] },
      effective: { providerAllowList: null, modelDenyList: [] },
    });
    expect(child?.defaultPolicy).toEqual({
      configured: { mode: 'none', selectedModelCount: 0, selectedProviderCount: 0 },
      effectiveGrant: { mode: 'all', selectedModelCount: 0, selectedProviderCount: 0 },
    });
    expect(child?.groupPolicies.enforcement).toBe('inactive_plan');
    expect(child?.dataCollection).toBe('deny');
    expect(child?.divergence).toEqual({
      organizationCeiling: {
        models: { parentOnly: [], childOnly: [] },
        providers: { parentOnly: [], childOnly: [] },
      },
      defaultAccess: {
        models: { parentOnly: [], childOnly: [] },
        providers: { parentOnly: [], childOnly: [] },
      },
    });
  });

  it('calculates default access from selected model and provider grants', async () => {
    const result = await summarize({
      defaultPolicyRows: [
        defaults(PARENT_ID, 'selected', { models: ['google/only'], providers: ['openai'] }),
        defaults(CHILD_ID, 'none'),
      ],
    });

    expect(result.children[0]?.divergence?.organizationCeiling.models).toEqual({
      parentOnly: [],
      childOnly: [],
    });
    expect(result.children[0]?.divergence?.defaultAccess.models).toEqual({
      parentOnly: ['google/only', 'openai/denied', 'openai/only', 'shared/model'],
      childOnly: [],
    });
    expect(result.children[0]?.divergence?.defaultAccess.providers.parentOnly).toEqual([
      'google',
      'openai',
    ]);
  });

  it('constrains default all by the organization ceiling and model deny list', async () => {
    const result = await summarize({
      child: organization({
        id: CHILD_ID,
        settings: { provider_allow_list: ['openai'], model_deny_list: ['openai/only'] },
      }),
      defaultPolicyRows: [defaults(CHILD_ID, 'all')],
    });

    expect(result.children[0]?.divergence?.defaultAccess.models.childOnly).toEqual([]);
    expect(result.children[0]?.divergence?.defaultAccess.models.parentOnly).toEqual([
      'anthropic/only',
      'google/only',
      'openai/only',
    ]);
  });

  it('uses legacy default all for a missing settings row and preserves missing group policies', async () => {
    const result = await summarize({
      groupRows: [
        {
          organizationId: CHILD_ID,
          groupId: '00000000-0000-4000-8000-000000000004',
          groupName: 'No policy',
          policies: [],
        },
      ],
    });

    expect(result.children[0]?.defaultPolicy).toEqual({
      configured: null,
      effectiveGrant: { mode: 'all', selectedModelCount: 0, selectedProviderCount: 0 },
    });
    expect(result.children[0]?.groupPolicies).toMatchObject({
      policyRevision: 0,
      groupCount: 1,
      groups: [{ groupName: 'No policy', modelAccessPolicy: null }],
    });
  });

  it('summarizes named groups without including them in default-access divergence', async () => {
    const baseline = await summarize({ defaultPolicyRows: [defaults(CHILD_ID, 'none')] });
    const withGroup = await summarize({
      defaultPolicyRows: [defaults(CHILD_ID, 'none')],
      groupRows: [
        {
          organizationId: CHILD_ID,
          groupId: '00000000-0000-4000-8000-000000000005',
          groupName: 'Selected',
          policies: [
            {
              type: 'model_access',
              data: {
                mode: 'selected',
                model_allow_list: ['shared/model', 'shared/model:free'],
                provider_allow_list: ['openai'],
              },
            },
          ],
        },
      ],
    });

    expect(withGroup.children[0]?.groupPolicies.groups[0]?.modelAccessPolicy).toEqual({
      mode: 'selected',
      selectedModelCount: 1,
      selectedProviderCount: 1,
    });
    expect(withGroup.children[0]?.divergence).toEqual(baseline.children[0]?.divergence);
  });

  it.each([
    ['missing', null],
    ['malformed', { providers: 'invalid' }],
  ])('returns unavailable and null divergence for a %s catalog', async (_label, catalog) => {
    const result = await summarize({ catalog });

    expect(result.catalog).toEqual({ status: 'unavailable' });
    expect(result.children[0]?.divergence).toBeNull();
  });

  it('reports catalog metadata with normalized, deduplicated model counts', async () => {
    const result = await summarize({});

    expect(result.catalog).toEqual({
      status: 'available',
      snapshotId: 42,
      generatedAt: '2026-08-04T00:00:00Z',
      distinctModelCount: 5,
      providerCount: 3,
    });
  });

  it('preserves Organization Auto configured, enabled, and inactive-plan states', async () => {
    const result = await summarize({
      parent: organization({
        id: PARENT_ID,
        settings: {
          org_auto_model: { routes: { code: 'openai/only' }, fallback_model: 'shared/model' },
        },
      }),
      child: organization({
        id: CHILD_ID,
        plan: 'teams',
        settings: {
          default_model: 'kilo-auto/org',
          org_auto_model: {
            routes: { code: 'openai/only', plan: 'anthropic/only' },
            fallback_model: 'shared/model',
          },
        },
      }),
    });

    expect(result.parent.orgAutoModel).toMatchObject({
      routeCount: 1,
      selectedAsDefault: false,
      status: 'configured_not_selected',
    });
    expect(result.children[0]?.orgAutoModel).toMatchObject({
      routeCount: 2,
      selectedAsDefault: true,
      status: 'inactive_plan',
    });
  });

  it('runtime-validates persisted settings and policy JSON', async () => {
    const invalidSettings = organization({ id: CHILD_ID });
    invalidSettings.settings = { provider_allow_list: [1] } as never;
    await expect(summarize({ child: invalidSettings })).rejects.toThrow();
    await expect(
      summarize({
        defaultPolicyRows: [
          { organizationId: CHILD_ID, policyRevision: 1, defaultPolicies: [{ bad: true }] },
        ],
      })
    ).rejects.toThrow();
  });
});
