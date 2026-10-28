import {
  isVirtualAutoModelId,
  type AutoRouter,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { hasBestEffortGuessDataCollectionRequirement } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { getDataCollectionRequiredModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { isDataCollectionExplicitlyDisallowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  allowsInferenceProviderByok,
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { modelsServedByOrganizationInferenceProviderByok } from '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-byok';

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
  policy: EffectiveOrganizationModelPolicy,
  router: AutoRouter
): Promise<string[]> {
  if (!policyNeedsCandidateEvaluation(policy)) return [];
  return deniedAutoRoutingCandidates(
    policy,
    candidateModelIdsFromTable(await getCachedRoutingTable(router))
  );
}

export async function deniedAutoRoutingCandidates(
  policy: EffectiveOrganizationModelPolicy,
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  // A policy that needs no evaluation has an unrestricted member grant, and the organization
  // deny list applies to baseline grants only, so it denies nothing.
  if (!policyNeedsCandidateEvaluation(policy)) return [];

  const uniqueCandidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const allowed = new Set<string>();
  const allowedForInferenceProviderByok: string[] = [];
  await Promise.all(
    uniqueCandidates.map(async modelId => {
      const decision = await getEffectiveModelDecision(policy, modelId);
      if (decision.allowed) {
        allowed.add(modelId);
      } else if (allowsInferenceProviderByok(decision)) {
        allowedForInferenceProviderByok.push(modelId);
      }
    })
  );
  for (const modelId of await modelsServedByOrganizationInferenceProviderByok(
    policy.customLlmGrantee.organizationId,
    allowedForInferenceProviderByok
  )) {
    allowed.add(modelId);
  }
  return deniedModelIdsForCandidates(policy, uniqueCandidates, modelId => allowed.has(modelId));
}

async function dataCollectionRequiredCandidates(
  candidateIds: ReadonlyArray<string>,
  dataCollectionRequiredModelIds: ReadonlySet<string>
): Promise<string[]> {
  const requiresDataCollection = await Promise.all(
    candidateIds.map(
      async modelId =>
        dataCollectionRequiredModelIds.has(modelId) ||
        (await hasBestEffortGuessDataCollectionRequirement(modelId))
    )
  );
  return candidateIds.filter((_modelId, index) => requiresDataCollection[index]);
}

export async function dataCollectionRequiredAutoRoutingCandidates(
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  return await dataCollectionRequiredCandidates(
    candidateIds,
    await getDataCollectionRequiredModelIds()
  );
}

export async function collectDataCollectionRequiredAutoRoutingModelIds(
  router: AutoRouter
): Promise<string[]> {
  const [table, dataCollectionRequiredModelIds] = await Promise.all([
    getCachedRoutingTable(router),
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
    fromDb: readDb,
  });
  const candidateIds = [...new Set(request.modelIds.filter(id => !isVirtualAutoModelId(id)))];
  const [deniedByPolicy, deniedByPrivacy] = await Promise.all([
    deniedAutoRoutingCandidates(policy, candidateIds),
    isDataCollectionExplicitlyDisallowed(
      getEffectiveProviderPrivacy(undefined, policy.dataCollection)
    )
      ? dataCollectionRequiredAutoRoutingCandidates(candidateIds)
      : [],
  ]);
  return [...new Set([...deniedByPolicy, ...deniedByPrivacy])];
}
