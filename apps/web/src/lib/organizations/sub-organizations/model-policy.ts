import type { Organization } from '@kilocode/db/schema';
import {
  NormalizedOpenRouterResponse,
  ORGANIZATION_AUTO_MODEL_ID,
  OrganizationSettingsSchema,
} from '@kilocode/db/schema-types';
import * as z from 'zod';

import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  findOrganizationGroupPolicy,
  OrganizationGroupPoliciesSchema,
  type OrganizationGroupPolicies,
} from '@/lib/organizations/group-policies/organization-group-policies';
import {
  evaluateEffectiveModelAccessPolicy,
  getEffectiveModelDecision,
} from '@/lib/organizations/effective-model-access.server';

const ModelAccessPolicySummarySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('all'),
    selectedModelCount: z.literal(0),
    selectedProviderCount: z.literal(0),
  }),
  z.object({
    mode: z.literal('none'),
    selectedModelCount: z.literal(0),
    selectedProviderCount: z.literal(0),
  }),
  z.object({
    mode: z.literal('selected'),
    selectedModelCount: z.number().int().nonnegative(),
    selectedProviderCount: z.number().int().nonnegative(),
  }),
]);

const OrganizationAutoSummarySchema = z
  .object({
    routeCount: z.number().int().nonnegative(),
    fallbackModel: z.string(),
    selectedAsDefault: z.boolean(),
    status: z.enum(['enabled', 'configured_not_selected', 'inactive_plan']),
  })
  .nullable();

const OrganizationModelPolicySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: z.enum(['teams', 'enterprise']),
  defaultModel: z.string().nullable(),
  dataCollection: z.enum(['allow', 'deny']).nullable(),
  organizationRestrictions: z.object({
    enforcement: z.enum(['enforced', 'inactive_plan']),
    configured: z.object({
      providerAllowList: z.array(z.string()).nullable(),
      modelDenyList: z.array(z.string()),
    }),
    effective: z.object({
      providerAllowList: z.array(z.string()).nullable(),
      modelDenyList: z.array(z.string()),
    }),
  }),
  orgAutoModel: OrganizationAutoSummarySchema,
  defaultPolicy: z.object({
    configured: ModelAccessPolicySummarySchema.nullable(),
    effectiveGrant: ModelAccessPolicySummarySchema,
  }),
  groupPolicies: z.object({
    enforcement: z.enum(['enforced', 'inactive_plan']),
    policyRevision: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    groups: z.array(
      z.object({
        groupId: z.uuid(),
        groupName: z.string(),
        modelAccessPolicy: ModelAccessPolicySummarySchema.nullable(),
      })
    ),
  }),
});

const CatalogDeltaSchema = z.object({
  models: z.object({ parentOnly: z.array(z.string()), childOnly: z.array(z.string()) }),
  providers: z.object({ parentOnly: z.array(z.string()), childOnly: z.array(z.string()) }),
});

const ModelPolicyDivergenceSchema = z.object({
  organizationCeiling: CatalogDeltaSchema,
  defaultAccess: CatalogDeltaSchema,
});

export const SubOrganizationModelPolicyOutputSchema = z.object({
  catalog: z.discriminatedUnion('status', [
    z.object({ status: z.literal('unavailable') }),
    z.object({
      status: z.literal('available'),
      snapshotId: z.number().int().nonnegative(),
      generatedAt: z.string(),
      distinctModelCount: z.number().int().nonnegative(),
      providerCount: z.number().int().nonnegative(),
    }),
  ]),
  parent: OrganizationModelPolicySummarySchema,
  children: z.array(
    OrganizationModelPolicySummarySchema.extend({
      divergence: ModelPolicyDivergenceSchema.nullable(),
    })
  ),
});

export type SubOrganizationModelPolicyOutput = z.infer<
  typeof SubOrganizationModelPolicyOutputSchema
>;
export type OrganizationModelPolicySummary = z.infer<typeof OrganizationModelPolicySummarySchema>;

export type OrganizationDefaultPolicyRow = {
  organizationId: string;
  defaultPolicies: unknown;
  policyRevision: number;
};

export type OrganizationGroupPolicyRow = {
  organizationId: string;
  groupId: string;
  groupName: string;
  policies: unknown;
};

export type ModelsByProviderSnapshotRow = {
  id: number;
  data: unknown;
};

export type SummarizeSubOrganizationModelPoliciesInput = {
  parent: Organization;
  children: readonly Organization[];
  defaultPolicyRows: readonly OrganizationDefaultPolicyRow[];
  groupRows: readonly OrganizationGroupPolicyRow[];
  catalogSnapshot: ModelsByProviderSnapshotRow | null;
};

type CatalogAccess = {
  models: Set<string>;
  providers: Set<string>;
};

type CatalogIndex = {
  modelIds: Set<string>;
  providerSlugs: Set<string>;
  providersByModelId: Map<string, Set<string>>;
};

const LEGACY_DEFAULT_POLICIES = [
  { type: 'model_access', data: { mode: 'all' } },
] satisfies OrganizationGroupPolicies;

function summarizePolicy(policies: OrganizationGroupPolicies) {
  const policy = findOrganizationGroupPolicy(policies, 'model_access');
  if (!policy) return null;
  if (policy.data.mode !== 'selected') {
    return {
      mode: policy.data.mode,
      selectedModelCount: 0,
      selectedProviderCount: 0,
    } as const;
  }
  return {
    mode: 'selected' as const,
    selectedModelCount: new Set(policy.data.model_allow_list.map(normalizeModelId)).size,
    selectedProviderCount: new Set(policy.data.provider_allow_list).size,
  };
}

function buildCatalogIndex(snapshot: z.infer<typeof NormalizedOpenRouterResponse>): CatalogIndex {
  const modelIds = new Set<string>();
  const providerSlugs = new Set<string>();
  const providersByModelId = new Map<string, Set<string>>();
  for (const provider of snapshot.providers) {
    providerSlugs.add(provider.slug);
    for (const model of provider.models) {
      const modelId = normalizeModelId(model.slug);
      modelIds.add(modelId);
      const providers = providersByModelId.get(modelId) ?? new Set<string>();
      providers.add(provider.slug);
      providersByModelId.set(modelId, providers);
    }
  }
  return { modelIds, providerSlugs, providersByModelId };
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return [...left].filter(value => !right.has(value)).sort();
}

function organizationAccessCacheKey(
  organization: Organization,
  defaultPolicies?: OrganizationGroupPolicies
) {
  const settings = OrganizationSettingsSchema.parse(organization.settings);
  return JSON.stringify({
    plan: organization.plan,
    providerAllowList: settings.provider_allow_list?.toSorted() ?? null,
    modelDenyList: (settings.model_deny_list ?? []).map(normalizeModelId).toSorted(),
    defaultPolicies: defaultPolicies ?? null,
  });
}

function calculateDelta(parent: CatalogAccess, child: CatalogAccess) {
  return {
    models: {
      parentOnly: setDifference(parent.models, child.models),
      childOnly: setDifference(child.models, parent.models),
    },
    providers: {
      parentOnly: setDifference(parent.providers, child.providers),
      childOnly: setDifference(child.providers, parent.providers),
    },
  };
}

async function calculateCatalogAccess(
  organization: Organization,
  defaultPolicies: OrganizationGroupPolicies,
  catalog: CatalogIndex
): Promise<CatalogAccess> {
  const policy = evaluateEffectiveModelAccessPolicy({
    organization,
    defaultPolicies,
    groupIds: [],
    groupPolicies: [],
    policyRevision: 0,
  });
  const models = new Set<string>();
  const providers = new Set<string>();
  for (const modelId of catalog.modelIds) {
    const modelProviders = catalog.providersByModelId.get(modelId) ?? new Set<string>();
    const decision = await getEffectiveModelDecision(policy, modelId, async () => modelProviders);
    if (!decision.allowed) continue;
    models.add(modelId);
    for (const provider of decision.eligibleProviderRoutes ?? modelProviders) {
      providers.add(provider);
    }
  }
  return { models, providers };
}

async function calculateOrganizationCeilingAccess(
  organization: Organization,
  catalog: CatalogIndex
): Promise<CatalogAccess> {
  const access = await calculateCatalogAccess(organization, LEGACY_DEFAULT_POLICIES, catalog);
  const settings = OrganizationSettingsSchema.parse(organization.settings);
  if (organization.plan !== 'enterprise' || settings.provider_allow_list === undefined) {
    return { models: access.models, providers: new Set(catalog.providerSlugs) };
  }
  const providerCeiling = new Set(settings.provider_allow_list);
  return {
    models: access.models,
    providers: new Set(
      [...catalog.providerSlugs].filter(provider => providerCeiling.has(provider))
    ),
  };
}

function summarizeOrganization(params: {
  organization: Organization;
  defaultPolicies: OrganizationGroupPolicies;
  configuredDefaultPolicies: OrganizationGroupPolicies | null;
  policyRevision: number;
  groups: Array<{
    groupId: string;
    groupName: string;
    policies: OrganizationGroupPolicies;
  }>;
}): OrganizationModelPolicySummary {
  const settings = OrganizationSettingsSchema.parse(params.organization.settings);
  const enforced = params.organization.plan === 'enterprise';
  const configuredDefaultPolicy = params.configuredDefaultPolicies
    ? summarizePolicy(params.configuredDefaultPolicies)
    : null;
  const effectiveDefaultPolicy = enforced ? summarizePolicy(params.defaultPolicies) : null;
  const orgAuto = settings.org_auto_model;
  const selectedAsDefault = settings.default_model === ORGANIZATION_AUTO_MODEL_ID;

  return {
    id: params.organization.id,
    name: params.organization.name,
    plan: params.organization.plan,
    defaultModel: settings.default_model ?? null,
    dataCollection: settings.data_collection ?? null,
    organizationRestrictions: {
      enforcement: enforced ? 'enforced' : 'inactive_plan',
      configured: {
        providerAllowList: settings.provider_allow_list ?? null,
        modelDenyList: settings.model_deny_list ?? [],
      },
      effective: {
        providerAllowList: enforced ? (settings.provider_allow_list ?? null) : null,
        modelDenyList: enforced
          ? [...new Set((settings.model_deny_list ?? []).map(normalizeModelId))]
          : [],
      },
    },
    orgAutoModel: orgAuto
      ? {
          routeCount: Object.keys(orgAuto.routes).length,
          fallbackModel: orgAuto.fallback_model,
          selectedAsDefault,
          status: !enforced
            ? 'inactive_plan'
            : selectedAsDefault
              ? 'enabled'
              : 'configured_not_selected',
        }
      : null,
    defaultPolicy: {
      configured: configuredDefaultPolicy,
      effectiveGrant: effectiveDefaultPolicy ?? {
        mode: 'all',
        selectedModelCount: 0,
        selectedProviderCount: 0,
      },
    },
    groupPolicies: {
      enforcement: enforced ? 'enforced' : 'inactive_plan',
      policyRevision: params.policyRevision,
      groupCount: params.groups.length,
      groups: params.groups
        .map(group => ({
          groupId: group.groupId,
          groupName: group.groupName,
          modelAccessPolicy: summarizePolicy(group.policies),
        }))
        .sort(
          (left, right) =>
            left.groupName.localeCompare(right.groupName) ||
            left.groupId.localeCompare(right.groupId)
        ),
    },
  };
}

/**
 * Summarizes already-loaded parent/child policy rows and compares each
 * organization's independent effective access against one catalog snapshot.
 */
export async function summarizeSubOrganizationModelPolicies(
  input: SummarizeSubOrganizationModelPoliciesInput
): Promise<SubOrganizationModelPolicyOutput> {
  const defaultRows = new Map(
    input.defaultPolicyRows.map(row => [
      row.organizationId,
      {
        policies: OrganizationGroupPoliciesSchema.parse(row.defaultPolicies),
        policyRevision: row.policyRevision,
      },
    ])
  );
  const groupsByOrganization = new Map<
    string,
    Array<{ groupId: string; groupName: string; policies: OrganizationGroupPolicies }>
  >();
  for (const row of input.groupRows) {
    const groups = groupsByOrganization.get(row.organizationId) ?? [];
    groups.push({
      groupId: row.groupId,
      groupName: row.groupName,
      policies: OrganizationGroupPoliciesSchema.parse(row.policies),
    });
    groupsByOrganization.set(row.organizationId, groups);
  }

  const organizations = [input.parent, ...input.children];
  const organizationData = new Map(
    organizations.map(organization => {
      const defaultRow = defaultRows.get(organization.id);
      const defaultPolicies = defaultRow?.policies ?? LEGACY_DEFAULT_POLICIES;
      return [
        organization.id,
        {
          organization,
          defaultPolicies,
          summary: summarizeOrganization({
            organization,
            defaultPolicies,
            configuredDefaultPolicies: defaultRow?.policies ?? null,
            policyRevision: defaultRow?.policyRevision ?? 0,
            groups: groupsByOrganization.get(organization.id) ?? [],
          }),
        },
      ];
    })
  );
  const parentData = organizationData.get(input.parent.id);
  if (!parentData) throw new Error('Parent organization summary is missing');

  const parsedCatalog = input.catalogSnapshot
    ? NormalizedOpenRouterResponse.safeParse(input.catalogSnapshot.data)
    : null;
  if (!input.catalogSnapshot || !parsedCatalog?.success) {
    return SubOrganizationModelPolicyOutputSchema.parse({
      catalog: { status: 'unavailable' },
      parent: parentData.summary,
      children: input.children.map(child => ({
        ...organizationData.get(child.id)?.summary,
        divergence: null,
      })),
    });
  }

  const catalog = buildCatalogIndex(parsedCatalog.data);
  const ceilingAccessCache = new Map<string, Promise<CatalogAccess>>();
  const defaultAccessCache = new Map<string, Promise<CatalogAccess>>();
  const getCeilingAccess = (organization: Organization) => {
    const key = organizationAccessCacheKey(organization);
    const cached = ceilingAccessCache.get(key);
    if (cached) return cached;
    const access = calculateOrganizationCeilingAccess(organization, catalog);
    ceilingAccessCache.set(key, access);
    return access;
  };
  const getDefaultAccess = (
    organization: Organization,
    defaultPolicies: OrganizationGroupPolicies
  ) => {
    const key = organizationAccessCacheKey(organization, defaultPolicies);
    const cached = defaultAccessCache.get(key);
    if (cached) return cached;
    const access = calculateCatalogAccess(organization, defaultPolicies, catalog);
    defaultAccessCache.set(key, access);
    return access;
  };
  const parentCeiling = await getCeilingAccess(input.parent);
  const parentDefaultAccess = await getDefaultAccess(input.parent, parentData.defaultPolicies);
  const children = await Promise.all(
    input.children.map(async child => {
      const childData = organizationData.get(child.id);
      if (!childData) throw new Error(`Child organization summary is missing: ${child.id}`);
      const [childCeiling, childDefaultAccess] = await Promise.all([
        getCeilingAccess(child),
        getDefaultAccess(child, childData.defaultPolicies),
      ]);
      return {
        ...childData.summary,
        divergence: {
          organizationCeiling: calculateDelta(parentCeiling, childCeiling),
          defaultAccess: calculateDelta(parentDefaultAccess, childDefaultAccess),
        },
      };
    })
  );

  return SubOrganizationModelPolicyOutputSchema.parse({
    catalog: {
      status: 'available',
      snapshotId: input.catalogSnapshot.id,
      generatedAt: parsedCatalog.data.generated_at,
      distinctModelCount: catalog.modelIds.size,
      providerCount: catalog.providerSlugs.size,
    },
    parent: parentData.summary,
    children,
  });
}
