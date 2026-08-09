import 'server-only';

import type { OrganizationGroupModelAccessPolicy } from '@/lib/organizations/group-policies/organization-group-policies';
import { modelsByProvider, organizations } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import { getKiloExclusiveInferenceProviderRestriction } from '@/lib/ai-gateway/models';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { db } from '@/lib/drizzle';
import {
  getOrganizationGroupPolicyContext,
  type OrganizationGroupPolicyContext,
} from '@/lib/organizations/organization-group-policy-context.server';

export type EffectiveOrganizationModelPolicy = {
  organizationModelDenyList: string[];
  organizationProviderCeiling?: string[];
  memberGrant:
    | { mode: 'unrestricted' }
    | { mode: 'selected'; modelAllowList: string[]; providerAllowList: string[] };
  dataCollection?: OrganizationSettings['data_collection'];
  policyRevision: number;
};

export type EffectiveModelDecision = {
  allowed: boolean;
  eligibleProviderRoutes?: ReadonlySet<string>;
  denialSource?:
    | 'organization_model'
    | 'organization_provider'
    | 'group_model'
    | 'group_provider'
    | 'no_grant';
};

export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

export function evaluateEffectiveModelAccessPolicy(
  context: OrganizationGroupPolicyContext
): EffectiveOrganizationModelPolicy {
  const organizationRestrictionsEnabled = context.organization.plan === 'enterprise';
  const organizationModelDenyList = organizationRestrictionsEnabled
    ? (context.organization.settings.model_deny_list ?? []).map(normalizeModelId)
    : [];
  const organizationProviderCeiling = organizationRestrictionsEnabled
    ? context.organization.settings.provider_allow_list
    : undefined;

  if (!organizationRestrictionsEnabled) {
    return {
      organizationModelDenyList,
      organizationProviderCeiling,
      memberGrant: { mode: 'unrestricted' },
      dataCollection: context.organization.settings.data_collection,
      policyRevision: context.policyRevision,
    };
  }

  const policies = [context.defaultPolicies, ...context.groupPolicies]
    .flat()
    .filter(policy => policy.type === 'model_access');
  if (policies.length === 0 || policies.some(policy => policy.data.mode === 'all')) {
    return {
      organizationModelDenyList,
      organizationProviderCeiling,
      memberGrant: { mode: 'unrestricted' },
      dataCollection: context.organization.settings.data_collection,
      policyRevision: context.policyRevision,
    };
  }

  const selectedPolicies = policies.filter(policy => policy.data.mode === 'selected');
  return {
    organizationModelDenyList,
    organizationProviderCeiling,
    memberGrant: {
      mode: 'selected',
      modelAllowList: [
        ...new Set(
          selectedPolicies.flatMap(policy =>
            policy.data.mode === 'selected'
              ? policy.data.model_allow_list.map(normalizeModelId)
              : []
          )
        ),
      ],
      providerAllowList: [
        ...new Set(
          selectedPolicies.flatMap(policy =>
            policy.data.mode === 'selected' ? policy.data.provider_allow_list : []
          )
        ),
      ],
    },
    dataCollection: context.organization.settings.data_collection,
    policyRevision: context.policyRevision,
  };
}

export async function getEffectiveModelDecision(
  policy: EffectiveOrganizationModelPolicy,
  modelId: string,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): Promise<EffectiveModelDecision> {
  const normalizedModelId = normalizeModelId(modelId);
  if (policy.organizationModelDenyList.includes(normalizedModelId)) {
    return { allowed: false, denialSource: 'organization_model' };
  }
  const organizationRoutes = policy.organizationProviderCeiling
    ? new Set(policy.organizationProviderCeiling)
    : undefined;

  async function lookupModelProviders(): Promise<ReadonlySet<string>> {
    return (
      getKiloExclusiveInferenceProviderRestriction(modelId) ??
      (await providerLookup(normalizedModelId))
    );
  }

  async function decisionWithinOrganizationCeiling(): Promise<EffectiveModelDecision> {
    if (!organizationRoutes) return { allowed: true };
    const modelProviders = await lookupModelProviders();
    if (modelProviders.size === 0) {
      return { allowed: true, eligibleProviderRoutes: organizationRoutes };
    }
    const eligibleProviderRoutes = new Set(
      [...modelProviders].filter(provider => organizationRoutes.has(provider))
    );
    return eligibleProviderRoutes.size > 0
      ? { allowed: true, eligibleProviderRoutes }
      : { allowed: false, denialSource: 'organization_provider' };
  }

  if (policy.memberGrant.mode === 'unrestricted') {
    return await decisionWithinOrganizationCeiling();
  }
  if (policy.memberGrant.modelAllowList.includes(normalizedModelId)) {
    return await decisionWithinOrganizationCeiling();
  }
  if (policy.memberGrant.providerAllowList.length === 0) {
    return { allowed: false, denialSource: 'no_grant' };
  }
  const modelProviders = await lookupModelProviders();
  if (modelProviders.size === 0) {
    return { allowed: false, denialSource: 'group_provider' };
  }
  const memberProviders = new Set(policy.memberGrant.providerAllowList);
  const eligibleProviderRoutes = new Set(
    [...modelProviders].filter(
      provider =>
        memberProviders.has(provider) && (!organizationRoutes || organizationRoutes.has(provider))
    )
  );
  if (eligibleProviderRoutes.size === 0) {
    return {
      allowed: false,
      denialSource: organizationRoutes ? 'organization_provider' : 'group_provider',
    };
  }
  return { allowed: true, eligibleProviderRoutes };
}

export async function isModelRouteAllowed(
  policy: EffectiveOrganizationModelPolicy,
  modelId: string,
  providerSlug: string,
  providerLookup: ProviderLookup = getProviderSlugsForModel
) {
  const decision = await getEffectiveModelDecision(policy, modelId, providerLookup);
  return (
    decision.allowed &&
    (!decision.eligibleProviderRoutes || decision.eligibleProviderRoutes.has(providerSlug))
  );
}

/**
 * Resolve a member's effective model-access policy once. Callers that need to
 * evaluate many models for one member should call this a single time and then
 * loop with `getEffectiveModelDecision`, rather than re-resolving the policy
 * context (a read-only transaction plus several queries) per model.
 */
export async function resolveOrganizationMemberModelPolicy(params: {
  organizationId: string;
  kiloUserId: string;
}): Promise<EffectiveOrganizationModelPolicy> {
  return evaluateEffectiveModelAccessPolicy(
    await getOrganizationGroupPolicyContext({
      organizationId: params.organizationId,
      subject: { type: 'member', kiloUserId: params.kiloUserId },
    })
  );
}

/**
 * Resolve an organization's default (non-member-specific) effective
 * model-access policy once. See `resolveOrganizationMemberModelPolicy` for the
 * per-model looping guidance.
 */
export async function resolveOrganizationDefaultModelPolicy(params: {
  organizationId: string;
}): Promise<EffectiveOrganizationModelPolicy> {
  return evaluateEffectiveModelAccessPolicy(
    await getOrganizationGroupPolicyContext({
      organizationId: params.organizationId,
      subject: { type: 'defaultAccess' },
    })
  );
}

export async function resolveOrganizationMemberModelDecision(params: {
  organizationId: string;
  kiloUserId: string;
  modelId: string;
  providerLookup?: ProviderLookup;
}) {
  const policy = await resolveOrganizationMemberModelPolicy(params);
  return {
    policy,
    decision: await getEffectiveModelDecision(policy, params.modelId, params.providerLookup),
  };
}

export async function resolveOrganizationDefaultModelDecision(params: {
  organizationId: string;
  modelId: string;
  providerLookup?: ProviderLookup;
}) {
  const policy = await resolveOrganizationDefaultModelPolicy(params);
  return await getEffectiveModelDecision(policy, params.modelId, params.providerLookup);
}

/**
 * Whether an organization-owned integration may set `modelId` as its default,
 * per the organization's default model-access policy.
 *
 * A missing or soft-deleted organization is treated as allowed: the policy
 * context throws `NOT_FOUND` in that case, but integration model updates
 * historically skipped the policy check entirely when the organization row was
 * absent, and `updateModel` must return a `{ success }` result rather than
 * throwing.
 */
export async function isOrganizationModelUpdateAllowed(
  organizationId: string,
  modelId: string
): Promise<boolean> {
  try {
    const { allowed } = await resolveOrganizationDefaultModelDecision({ organizationId, modelId });
    return allowed;
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return true;
    throw error;
  }
}

export function normalizeModelAccessPolicy(
  policy: OrganizationGroupModelAccessPolicy
): OrganizationGroupModelAccessPolicy {
  if (policy.data.mode !== 'selected') return policy;
  return {
    type: 'model_access',
    data: {
      mode: 'selected',
      model_allow_list: [
        ...new Set(policy.data.model_allow_list.map(value => normalizeModelId(value.trim()))),
      ].sort(),
      provider_allow_list: [
        ...new Set(
          policy.data.provider_allow_list.map(value => normalizeInferenceProviderId(value.trim()))
        ),
      ].sort(),
    },
  };
}

export async function getModelAccessPolicyEditorData(organizationId: string) {
  const [[organization], [catalog]] = await Promise.all([
    db
      .select({ plan: organizations.plan, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
    db
      .select({ data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1),
  ]);
  if (!organization || organization.plan !== 'enterprise') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Enterprise organization not found' });
  }
  if (!catalog) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Model and provider catalog has not been synchronized.',
    });
  }
  return {
    policyType: 'model_access' as const,
    catalog: catalog.data,
    modelDenyList: organization.settings.model_deny_list ?? [],
    providerAllowList: organization.settings.provider_allow_list,
  };
}
