import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import { getAutoRoutingSettings } from '@/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { hasBestEffortGuessDataCollectionRequirement } from '@/lib/ai-gateway/is-free-model';
import { getModelDataPolicies } from '@/lib/ai-gateway/providers/openrouter/model-data-policy.server';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  isDataCollectionExplicitlyDisallowed,
  type OpenRouterProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import {
  getEffectiveModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

// Keep in sync with services/auto-routing/src/coding-plan-preference.ts.
// /decide can short-circuit to these without consulting the routing table.
const CODING_PLAN_DEFAULT_MODEL_IDS = [
  MINIMAX_CURRENT_MODEL_ID,
  'byteplus-coding/bytedance-seed-code',
] as const;

export type AutoRoutingOwner = {
  userId: string;
  organizationId: string | null;
};

export function policyNeedsCandidateEvaluation(policy: EffectiveOrganizationModelPolicy): boolean {
  return (
    policy.requireModelInCurrentSnapshot === true ||
    policy.organizationProviderCeiling !== undefined ||
    policy.memberGrant.mode !== 'unrestricted'
  );
}

export function candidateModelIdsFromSources(
  table: { routes: Record<string, ReadonlyArray<{ model: string }>> } | null,
  poolModelIds: ReadonlyArray<string> | null
): string[] {
  const fromPoolOrTable =
    poolModelIds ??
    Object.values(table?.routes ?? {}).flatMap(candidates =>
      candidates.map(candidate => candidate.model)
    );
  return [
    ...new Set(
      [...fromPoolOrTable, ...CODING_PLAN_DEFAULT_MODEL_IDS, PRIMARY_DEFAULT_MODEL].filter(
        id => !isVirtualAutoModelId(id)
      )
    ),
  ];
}

export function deniedModelIdsForCandidates(
  policy: EffectiveOrganizationModelPolicy,
  candidateIds: ReadonlyArray<string>,
  isAllowed: (modelId: string) => boolean
): string[] {
  const normalizedDeny = new Set(
    policy.memberGrant.mode === 'organization_baseline'
      ? policy.organizationModelDenyList.map(normalizeModelId)
      : []
  );
  const denied = new Set(normalizedDeny);
  for (const candidate of new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))) {
    if (normalizedDeny.has(normalizeModelId(candidate)) || !isAllowed(candidate)) {
      denied.add(candidate);
    }
  }
  return [...denied];
}

export async function loadEffectivePoolModelIds(owner: AutoRoutingOwner): Promise<string[] | null> {
  const owners = [
    ...(owner.organizationId ? [{ ownerType: 'org' as const, ownerId: owner.organizationId }] : []),
    { ownerType: 'user' as const, ownerId: owner.userId },
  ];
  const results = await Promise.all(owners.map(getAutoRoutingSettings));
  for (const result of results) {
    if (result.status !== 200 || !('configuredPool' in result.body)) continue;
    const pool = result.body.configuredPool;
    if (pool && pool.length > 0) {
      return pool.map(entry => entry.model);
    }
  }
  return null;
}

export async function loadAutoRoutingCandidateModelIds(owner: AutoRoutingOwner): Promise<string[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [table, poolModelIds] = await Promise.race([
      Promise.all([getCachedRoutingTable(), loadEffectivePoolModelIds(owner)]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Auto routing candidate lookup timed out')),
          5000
        );
      }),
    ]);
    return candidateModelIdsFromSources(table, poolModelIds);
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy | null,
  owner: AutoRoutingOwner,
  provider?: OpenRouterProviderConfig
): Promise<string[]> {
  const privacyProvider = {
    ...provider,
    ...(policy?.dataCollection === 'deny' && { data_collection: 'deny' as const }),
  };
  const checkPrivacy = isDataCollectionExplicitlyDisallowed(privacyProvider);
  const checkAccess = policy !== null && policyNeedsCandidateEvaluation(policy);
  if (!checkPrivacy && !checkAccess && !policy?.organizationModelDenyList.length) {
    return [];
  }

  const [candidateIds, dataPolicies] = await Promise.all([
    loadAutoRoutingCandidateModelIds(owner),
    checkPrivacy ? getModelDataPolicies() : undefined,
  ]);
  const uniqueCandidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const allowed = new Set<string>();
  await Promise.all(
    uniqueCandidates.map(async modelId => {
      const decision = checkAccess
        ? await getEffectiveModelDecision(policy, modelId)
        : { allowed: true, eligibleProviderRoutes: undefined };
      if (!decision.allowed) return;
      if (checkPrivacy) {
        if (await hasBestEffortGuessDataCollectionRequirement(modelId)) return;
        const routes = dataPolicies?.get(modelId);
        if (routes?.length) {
          const eligible = routes.filter(route => {
            const slug = normalizeInferenceProviderId(route.providerSlug);
            return (
              (!decision.eligibleProviderRoutes || decision.eligibleProviderRoutes.has(slug)) &&
              (!privacyProvider.only ||
                privacyProvider.only.some(id => normalizeInferenceProviderId(id) === slug)) &&
              !privacyProvider.ignore?.some(id => normalizeInferenceProviderId(id) === slug)
            );
          });
          if (
            !eligible.some(
              route => !route.training && (privacyProvider.zdr !== true || !route.retainsPrompts)
            )
          ) {
            return;
          }
        }
      }
      allowed.add(modelId);
    })
  );
  return policy
    ? deniedModelIdsForCandidates(policy, uniqueCandidates, modelId => allowed.has(modelId))
    : uniqueCandidates.filter(modelId => !allowed.has(modelId));
}
