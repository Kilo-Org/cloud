import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import { BALANCED_QWEN_MODEL } from '@/lib/ai-gateway/auto-model';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import {
  getEffectiveModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

// Keep in sync with services/auto-routing/src/coding-plan-preference.ts.
const BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID = 'byteplus-coding/bytedance-seed-code';

const ALWAYS_CONSIDERED_MODEL_IDS = [
  BALANCED_QWEN_MODEL.model,
  MINIMAX_CURRENT_MODEL_ID,
  BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID,
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

export async function loadAutoRoutingCandidateModelIds(): Promise<string[]> {
  const table = await getCachedRoutingTable();
  const fromTable = Object.values(table?.routes ?? {}).flatMap(candidates =>
    candidates.map(candidate => candidate.model)
  );
  return [
    ...new Set(
      [...fromTable, ...ALWAYS_CONSIDERED_MODEL_IDS].filter(id => !isVirtualAutoModelId(id))
    ),
  ];
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
