import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  getModelUserByokProviders,
  type EnabledByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { hasEnabledUserByokForModel } from '@kilocode/web-shared/lib/ai-gateway/byok/availability';
import {
  getCatalogModeModelIds,
  getDirectByokModel,
  getDirectByokPolicyProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getVercelInferenceRegions } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * Whether a Kilo-paid route can serve the model pinned to the inference region. Only routes that
 * honor an inference region may serve such a request (see `getGatewaySettingsRefusal`); add any
 * upstream that gains region pinning here.
 */
export async function isModelServableInInferenceRegion(
  modelId: string,
  region: OrganizationDataRegion
): Promise<boolean> {
  if (await isCustomLlm(modelId)) return false;
  return (await getVercelInferenceRegions(modelId))?.has(region) ?? false;
}

/** The providers the policy lets serve the model, as `resolveAccessCheck` derives them. */
async function allowedProvidersForModel(
  policy: EffectiveOrganizationModelPolicy | null,
  modelId: string
): Promise<ReadonlySet<string> | undefined> {
  if (!policy) return undefined;
  const decision = await getEffectiveModelDecision(policy, modelId);
  return decision.allowed ? decision.eligibleProviderRoutes : new Set();
}

/**
 * The candidates the owner's enabled BYOK keys serve, as routing would use them under the
 * organization policy. Such a route is the user's own and exempt from the inference region (see
 * `getGatewaySettingsRefusal`). A custom LLM never counts, because routing serves it first. Linked
 * ChatGPT subscriptions and Claude billing connections are not considered.
 */
async function candidatesServedByOwnerByok(
  keys: readonly EnabledByokProvider[],
  policy: EffectiveOrganizationModelPolicy | null,
  candidateIds: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const enabledProviderIds = new Set(keys.map(key => key.providerId));
  const isProviderKeyAllowed = async (modelId: string, policyProviderId: string) =>
    !policy || (await isModelAllowedForProviderKey(policy, modelId, policyProviderId));
  const catalogModelIds = await getCatalogModeModelIds(keys, isProviderKeyAllowed);
  const served = await Promise.all(
    candidateIds.map(async modelId => {
      if (await isCustomLlm(modelId)) return false;
      if (catalogModelIds.has(modelId)) return true;
      const directByok = await getDirectByokModel(modelId);
      if (directByok) {
        return (
          enabledProviderIds.has(directByok.provider.id) &&
          (await isProviderKeyAllowed(modelId, getDirectByokPolicyProviderId(directByok.provider)))
        );
      }
      return hasEnabledUserByokForModel({
        modelId,
        modelProviders: await getModelUserByokProviders(modelId, enabledProviderIds),
        enabledProviderIds,
        allowedProviders: await allowedProvidersForModel(policy, modelId),
      });
    })
  );
  return new Set(candidateIds.filter((_modelId, index) => served[index]));
}

/**
 * The candidates an organization's inference region rules out: a model no Kilo-paid route can serve
 * pinned to the region (see `isModelServableInInferenceRegion`) fails unless the owner's own BYOK
 * key serves it. Auto routing denies these so it never picks a model the request then fails on.
 * `loadByokKeys` returns the owner's enabled keys and is called only when a candidate is outside
 * the region; without it, BYOK keys are not considered. `policy` is the member's organization
 * model policy, which decides which keys routing may use.
 */
export async function inferenceRegionIneligibleCandidates(params: {
  region: OrganizationDataRegion;
  candidateIds: ReadonlyArray<string>;
  loadByokKeys: (() => Promise<readonly EnabledByokProvider[]>) | null;
  policy: EffectiveOrganizationModelPolicy | null;
}): Promise<string[]> {
  const { region, loadByokKeys, policy } = params;
  const candidateIds = [...new Set(params.candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const eligible = await Promise.all(
    candidateIds.map(modelId => isModelServableInInferenceRegion(modelId, region))
  );
  const outsideRegion = candidateIds.filter((_modelId, index) => !eligible[index]);
  if (outsideRegion.length === 0 || !loadByokKeys) return outsideRegion;
  const servedByByok = await candidatesServedByOwnerByok(
    await loadByokKeys(),
    policy,
    outsideRegion
  );
  return outsideRegion.filter(modelId => !servedByByok.has(modelId));
}
