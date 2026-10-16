import {
  isVirtualAutoModelId,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { hasBestEffortGuessDataCollectionRequirement } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { getDataCollectionRequiredModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { isDataCollectionExplicitlyDisallowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

export function policyNeedsCandidateEvaluation(policy: EffectiveOrganizationModelPolicy): boolean {
  return (
    policy.requireModelInCurrentSnapshot === true ||
    policy.organizationProviderCeiling !== undefined ||
    policy.memberGrant.mode !== 'unrestricted'
  );
}

export function candidateModelIdsFromTable(
  table: { routes: Record<string, ReadonlyArray<{ model: string }>> } | null
): string[] {
  const fromTable = Object.values(table?.routes ?? {}).flatMap(candidates =>
    candidates.map(candidate => candidate.model)
  );
  return [...new Set(fromTable.filter(id => !isVirtualAutoModelId(id)))];
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

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy
): Promise<string[]> {
  if (!policyNeedsCandidateEvaluation(policy) && policy.organizationModelDenyList.length === 0) {
    return [];
  }
  return deniedAutoRoutingCandidates(
    policy,
    candidateModelIdsFromTable(await getCachedRoutingTable())
  );
}

export async function deniedAutoRoutingCandidates(
  policy: EffectiveOrganizationModelPolicy,
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  if (!policyNeedsCandidateEvaluation(policy)) {
    return policy.organizationModelDenyList.length === 0
      ? []
      : deniedModelIdsForCandidates(policy, candidateIds, () => true);
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

function dataCollectionRequiredCandidates(
  candidateIds: ReadonlyArray<string>,
  dataCollectionRequiredModelIds: ReadonlySet<string>
): string[] {
  return candidateIds.filter(
    modelId =>
      hasBestEffortGuessDataCollectionRequirement(modelId) ||
      dataCollectionRequiredModelIds.has(modelId)
  );
}

export async function collectDataCollectionRequiredAutoRoutingModelIds(): Promise<string[]> {
  const [table, dataCollectionRequiredModelIds] = await Promise.all([
    getCachedRoutingTable(),
    getDataCollectionRequiredModelIds(),
  ]);
  return dataCollectionRequiredCandidates(
    candidateModelIdsFromTable(table),
    dataCollectionRequiredModelIds
  );
}

// The gateway evaluation for named candidates, served to the auto-routing worker's CLI path.
// A CLI request carries no provider privacy of its own, so only the organization's
// data-collection setting can deny data-collection-required models.
export async function deniedAutoRoutingModelIdsForMember(
  request: AutoRoutingDeniedModelsRequest
): Promise<string[]> {
  const policy = await resolveOrganizationMemberModelPolicy({
    organizationId: request.organizationId,
    kiloUserId: request.userId,
  });
  const candidateIds = [...new Set(request.modelIds.filter(id => !isVirtualAutoModelId(id)))];
  const [deniedByPolicy, deniedByPrivacy] = await Promise.all([
    deniedAutoRoutingCandidates(policy, candidateIds),
    isDataCollectionExplicitlyDisallowed(
      getEffectiveProviderPrivacy(undefined, policy.dataCollection)
    )
      ? getDataCollectionRequiredModelIds().then(requiredIds =>
          dataCollectionRequiredCandidates(candidateIds, requiredIds)
        )
      : [],
  ]);
  return [...new Set([...deniedByPolicy, ...deniedByPrivacy])];
}
