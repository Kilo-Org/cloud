import {
  isVirtualAutoModelId,
  type AutoRouter,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { getAutoRoutingSettings } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { findEffectiveLegacyPoolRouter } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
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
  return [...new Set(fromPoolOrTable.filter(id => !isVirtualAutoModelId(id)))];
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
  const migrated = await findEffectiveLegacyPoolRouter(owner);
  if (migrated) {
    return migrated.entries.flatMap(entry => (entry.kind === 'gateway' ? [entry.model] : []));
  }
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
  owner: AutoRoutingOwner,
  router: AutoRouter
): Promise<string[]> {
  const [table, poolModelIds] = await Promise.all([
    getCachedRoutingTable(router),
    router === 'efficient' ? loadEffectivePoolModelIds(owner) : null,
  ]);
  return candidateModelIdsFromSources(table, poolModelIds);
}

export async function collectDeniedAutoRoutingModelIds(
  policy: EffectiveOrganizationModelPolicy,
  owner: AutoRoutingOwner,
  router: AutoRouter
): Promise<string[]> {
  if (!policyNeedsCandidateEvaluation(policy)) return [];
  return deniedAutoRoutingCandidates(policy, await loadAutoRoutingCandidateModelIds(owner, router));
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

export async function dataCollectionRequiredAutoRoutingCandidates(
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  return dataCollectionRequiredCandidates(candidateIds, await getDataCollectionRequiredModelIds());
}

export async function collectDataCollectionRequiredAutoRoutingModelIds(
  owner: AutoRoutingOwner,
  router: AutoRouter
): Promise<string[]> {
  const [candidateIds, dataCollectionRequiredModelIds] = await Promise.all([
    loadAutoRoutingCandidateModelIds(owner, router),
    getDataCollectionRequiredModelIds(),
  ]);
  return dataCollectionRequiredCandidates(candidateIds, dataCollectionRequiredModelIds);
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
      ? dataCollectionRequiredAutoRoutingCandidates(candidateIds)
      : [],
  ]);
  return [...new Set([...deniedByPolicy, ...deniedByPrivacy])];
}
