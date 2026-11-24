import {
  isVirtualAutoModelId,
  type AutoRouter,
  type AutoRoutingDeniedModelsRequest,
  type AutoRoutingDeniedModelsResponse,
  type ClassifierRoute,
} from '@kilocode/auto-routing-contracts';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isLatestAliasId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import { isDeniedByProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  getDataCollectionRequiredModelIds,
  getProviderSlugsForModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { isDataCollectionExplicitlyDisallowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  allowsInferenceProviderUserByok,
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  getAllowedDirectByokCatalogModelIds,
  modelsServedByOrganizationInferenceProviderUserByok,
} from '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-user-byok';

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
  const denied: string[] = [];
  const allowedForInferenceProviderUserByok: string[] = [];
  await Promise.all(
    uniqueCandidates.map(async modelId => {
      const decision = await getEffectiveModelDecision(policy, modelId);
      if (decision.allowed) {
        allowed.add(modelId);
        return;
      }
      denied.push(modelId);
      if (allowsInferenceProviderUserByok(decision)) {
        allowedForInferenceProviderUserByok.push(modelId);
      }
    })
  );
  const directByokCatalogModelIds =
    denied.length > 0
      ? await getAllowedDirectByokCatalogModelIds(policy.customLlmGrantee.organizationId, policy)
      : new Set<string>();
  for (const modelId of denied) {
    if (directByokCatalogModelIds.has(modelId)) allowed.add(modelId);
  }
  for (const modelId of await modelsServedByOrganizationInferenceProviderUserByok(
    policy.customLlmGrantee.organizationId,
    allowedForInferenceProviderUserByok
  )) {
    allowed.add(modelId);
  }
  return deniedModelIdsForCandidates(policy, uniqueCandidates, modelId => allowed.has(modelId));
}

/** `zdr` also denies every custom LLM; see `isDeniedByProviderPrivacy`. */
async function dataCollectionRequiredCandidates(
  candidateIds: ReadonlyArray<string>,
  dataCollectionRequiredModelIds: ReadonlySet<string>,
  zdr: boolean
): Promise<string[]> {
  const privacy = zdr ? { zdr } : { data_collection: 'deny' as const };
  const requiresDataCollection = await Promise.all(
    candidateIds.map(
      async modelId =>
        dataCollectionRequiredModelIds.has(modelId) ||
        (await isDeniedByProviderPrivacy(modelId, privacy))
    )
  );
  return candidateIds.filter((_modelId, index) => requiresDataCollection[index]);
}

export async function dataCollectionRequiredAutoRoutingCandidates(
  candidateIds: ReadonlyArray<string>,
  { zdr = false }: { zdr?: boolean } = {}
): Promise<string[]> {
  return await dataCollectionRequiredCandidates(
    candidateIds,
    await getDataCollectionRequiredModelIds(),
    zdr
  );
}

export async function collectDataCollectionRequiredAutoRoutingModelIds(
  router: AutoRouter,
  { zdr = false }: { zdr?: boolean } = {}
): Promise<string[]> {
  const [table, dataCollectionRequiredModelIds] = await Promise.all([
    getCachedRoutingTable(router),
    getDataCollectionRequiredModelIds(),
  ]);
  return dataCollectionRequiredCandidates(
    candidateModelIdsFromTable(table),
    dataCollectionRequiredModelIds,
    zdr
  );
}

// The classifier uses Kilo's OpenRouter credential. A candidate served by the organization's
// own provider key can be allowed downstream without authorizing that same model here.
async function classifierRoute(
  policy: EffectiveOrganizationModelPolicy,
  configuredModel: string
): Promise<ClassifierRoute | null> {
  const model = await resolveOpenRouterModelAlias(configuredModel);
  if (isLatestAliasId(model) || isVirtualAutoModelId(model)) return null;
  let only: string[] | undefined;
  for (const id of new Set([configuredModel, model])) {
    const decision = await getEffectiveModelDecision(
      policy,
      id,
      getProviderSlugsForModel,
      'openrouter-catalog'
    );
    if (!decision.allowed) return null;
    if (decision.eligibleProviderRoutes) {
      const routes = decision.eligibleProviderRoutes;
      only = only
        ? only.filter(provider => routes.has(provider))
        : withoutVirtualProvider([...routes]);
      if (!only.length) return null;
    }
  }
  const privacy = getEffectiveProviderPrivacy(undefined, policy.dataCollection);
  return {
    model,
    ...(only || privacy.data_collection ? { provider: { ...privacy, ...(only && { only }) } } : {}),
  };
}

export async function autoRoutingPolicyForMember(
  request: AutoRoutingDeniedModelsRequest
): Promise<AutoRoutingDeniedModelsResponse> {
  const policy = await resolveOrganizationMemberModelPolicy({
    organizationId: request.organizationId,
    kiloUserId: request.userId,
    fromDb: readDb,
  });
  const candidateIds = [...new Set(request.modelIds.filter(id => !isVirtualAutoModelId(id)))];
  const [deniedByPolicy, deniedByPrivacy, route] = await Promise.all([
    candidateIds.length ? deniedAutoRoutingCandidates(policy, candidateIds) : [],
    candidateIds.length &&
    isDataCollectionExplicitlyDisallowed(
      getEffectiveProviderPrivacy(undefined, policy.dataCollection)
    )
      ? dataCollectionRequiredAutoRoutingCandidates(candidateIds)
      : [],
    request.classifierModel ? classifierRoute(policy, request.classifierModel) : undefined,
  ]);
  return {
    deniedModelIds: [...new Set([...deniedByPolicy, ...deniedByPrivacy])],
    ...(route !== undefined && { classifierRoute: route }),
  };
}
