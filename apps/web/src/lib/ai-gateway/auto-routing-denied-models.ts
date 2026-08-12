import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
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

export type CollectDeniedAutoRoutingModelIdsOptions = {
  candidateModelIds?: ReadonlyArray<string>;
  loadCandidateModelIds?: () => Promise<ReadonlyArray<string>>;
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

export function candidateModelIdsFromRoutingTable(
  table: { routes: Record<string, ReadonlyArray<{ model: string }>> } | null
): string[] {
  const fromTable = Object.values(table?.routes ?? {}).flatMap(candidates =>
    candidates.map(candidate => candidate.model)
  );
  return [
    ...new Set(
      [...fromTable, ...CODING_PLAN_DEFAULT_MODEL_IDS].filter(id => !isVirtualAutoModelId(id))
    ),
  ];
}

export async function loadAutoRoutingCandidateModelIds(): Promise<string[]> {
  return candidateModelIdsFromRoutingTable(await getCachedRoutingTable());
}

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy,
  options: CollectDeniedAutoRoutingModelIdsOptions = {}
): Promise<string[]> {
  const denied = new Set(
    (policy.organizationModelDenyList ?? []).map(modelId => normalizeModelId(modelId))
  );
  if (!policyNeedsCandidateEvaluation(policy) && options.candidateModelIds === undefined) {
    return [...denied];
  }

  const candidateIds =
    options.candidateModelIds ??
    (await (options.loadCandidateModelIds ?? loadAutoRoutingCandidateModelIds)());
  const decide = options.decideModel ?? getEffectiveModelDecision;
  const decisions = await Promise.all(
    [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))].map(async modelId => ({
      modelId: normalizeModelId(modelId),
      allowed: (await decide(policy, modelId)).allowed,
    }))
  );
  for (const { modelId, allowed } of decisions) {
    if (!allowed) denied.add(modelId);
  }
  return [...denied];
}
