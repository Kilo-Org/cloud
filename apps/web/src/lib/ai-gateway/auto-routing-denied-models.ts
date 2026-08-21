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
      [...fromPoolOrTable, ...CODING_PLAN_DEFAULT_MODEL_IDS].filter(id => !isVirtualAutoModelId(id))
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
  const [table, poolModelIds] = await Promise.all([
    getCachedRoutingTable(),
    loadEffectivePoolModelIds(owner),
  ]);
  return candidateModelIdsFromSources(table, poolModelIds);
}

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy,
  owner: AutoRoutingOwner
): Promise<string[]> {
  if (!policyNeedsCandidateEvaluation(policy) && policy.organizationModelDenyList.length === 0) {
    return [];
  }

  const candidateIds = await loadAutoRoutingCandidateModelIds(owner);
  if (!policyNeedsCandidateEvaluation(policy)) {
    return deniedModelIdsForCandidates(policy, candidateIds, () => true);
  }

  const uniqueCandidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const allowed = new Set<string>();
  await Promise.all(
    uniqueCandidates.map(async modelId => {
      if ((await getEffectiveModelDecision(policy, modelId)).allowed) {
        allowed.add(modelId);
      }
    })
  );
  return deniedModelIdsForCandidates(policy, uniqueCandidates, modelId => allowed.has(modelId));
}
