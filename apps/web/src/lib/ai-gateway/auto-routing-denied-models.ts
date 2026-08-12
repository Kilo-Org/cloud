import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import { getAutoRoutingSettings } from '@/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
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

export type CollectDeniedAutoRoutingModelIdsOptions = {
  candidateModelIds?: ReadonlyArray<string>;
  loadCandidateModelIds?: () => Promise<ReadonlyArray<string>>;
  owner?: AutoRoutingOwner;
  loadEffectivePoolModelIds?: (owner: AutoRoutingOwner) => Promise<ReadonlyArray<string> | null>;
  decideModel?: (
    policy: EffectiveOrganizationModelPolicy,
    modelId: string
  ) => Promise<{ allowed: boolean }>;
};

export function policyNeedsCandidateEvaluation(policy: EffectiveOrganizationModelPolicy): boolean {
  return (
    policy.requireModelInCurrentSnapshot === true ||
    policy.organizationProviderCeiling !== undefined ||
    policy.memberGrant?.mode === 'selected'
  );
}

export function candidateModelIdsFromSources(params: {
  table: { routes: Record<string, ReadonlyArray<{ model: string }>> } | null;
  poolModelIds: ReadonlyArray<string> | null;
}): string[] {
  const fromPoolOrTable =
    params.poolModelIds ??
    Object.values(params.table?.routes ?? {}).flatMap(candidates =>
      candidates.map(candidate => candidate.model)
    );
  return [
    ...new Set(
      [...fromPoolOrTable, ...CODING_PLAN_DEFAULT_MODEL_IDS].filter(id => !isVirtualAutoModelId(id))
    ),
  ];
}

export function candidateModelIdsFromRoutingTable(
  table: { routes: Record<string, ReadonlyArray<{ model: string }>> } | null
): string[] {
  return candidateModelIdsFromSources({ table, poolModelIds: null });
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

export async function loadAutoRoutingCandidateModelIds(
  owner?: AutoRoutingOwner,
  loadPool: (
    owner: AutoRoutingOwner
  ) => Promise<ReadonlyArray<string> | null> = loadEffectivePoolModelIds
): Promise<string[]> {
  const [table, poolModelIds] = await Promise.all([
    getCachedRoutingTable(),
    owner ? loadPool(owner) : Promise.resolve(null),
  ]);
  return candidateModelIdsFromSources({ table, poolModelIds });
}

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy,
  options: CollectDeniedAutoRoutingModelIdsOptions = {}
): Promise<string[]> {
  const denyList = policy.organizationModelDenyList ?? [];
  const normalizedDeny = new Set(denyList.map(normalizeModelId));
  const denied = new Set(normalizedDeny);
  const shouldEvaluateCandidates =
    policyNeedsCandidateEvaluation(policy) ||
    options.candidateModelIds !== undefined ||
    (options.owner !== undefined && normalizedDeny.size > 0);
  if (!shouldEvaluateCandidates) {
    return [...denied];
  }

  const candidateIds =
    options.candidateModelIds ??
    (options.loadCandidateModelIds
      ? await options.loadCandidateModelIds()
      : await loadAutoRoutingCandidateModelIds(options.owner, options.loadEffectivePoolModelIds));
  const uniqueCandidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  for (const candidate of uniqueCandidates) {
    if (normalizedDeny.has(normalizeModelId(candidate))) {
      denied.add(candidate);
    }
  }

  if (policyNeedsCandidateEvaluation(policy)) {
    const decide = options.decideModel ?? getEffectiveModelDecision;
    const decisions = await Promise.all(
      uniqueCandidates.map(async modelId => ({
        modelId,
        allowed: (await decide(policy, modelId)).allowed,
      }))
    );
    for (const { modelId, allowed } of decisions) {
      if (!allowed) denied.add(modelId);
    }
  }
  return [...denied];
}
