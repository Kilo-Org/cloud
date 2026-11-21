import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  getEnabledByokProviders,
  getModelUserByokProviders,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { hasEnabledUserByokForModel } from '@kilocode/web-shared/lib/ai-gateway/byok/availability';
import {
  getCatalogModeModelIds,
  getDirectByokModel,
  getDirectByokPolicyProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isVercelModelInInferenceRegion } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

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
  owner: ByokOwner,
  policy: EffectiveOrganizationModelPolicy | null,
  candidateIds: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  const keys = await getEnabledByokProviders(readDb, owner);
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
 * The candidates an organization's inference region rules out: Kilo pays for them only through its
 * Vercel AI Gateway route pinned to the region, so a model Vercel cannot pin there, or a custom LLM,
 * fails unless the owner's own BYOK key serves it. Auto routing denies these so it never picks a
 * model the request then fails on. Without `byokOwner`, BYOK keys are not considered; `policy` is
 * the member's organization model policy, which decides which keys routing may use.
 */
export async function inferenceRegionIneligibleCandidates(params: {
  region: OrganizationDataRegion;
  candidateIds: ReadonlyArray<string>;
  byokOwner: ByokOwner | null;
  policy: EffectiveOrganizationModelPolicy | null;
}): Promise<string[]> {
  const { region, byokOwner, policy } = params;
  const candidateIds = [...new Set(params.candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const eligible = await Promise.all(
    candidateIds.map(
      async modelId =>
        !(await isCustomLlm(modelId)) && (await isVercelModelInInferenceRegion(modelId, region))
    )
  );
  const outsideRegion = candidateIds.filter((_modelId, index) => !eligible[index]);
  if (outsideRegion.length === 0 || !byokOwner) return outsideRegion;
  const servedByByok = await candidatesServedByOwnerByok(byokOwner, policy, outsideRegion);
  return outsideRegion.filter(modelId => !servedByByok.has(modelId));
}
