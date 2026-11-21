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
  getDirectByokCatalogModelIds,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isVercelModelInInferenceRegion } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';

/**
 * The candidates the owner's enabled BYOK keys serve. Such a route is the user's own and exempt from
 * the inference region (see `getGatewaySettingsRefusal`). Linked ChatGPT subscriptions and Claude
 * billing connections are not considered.
 */
async function candidatesServedByOwnerByok(
  owner: ByokOwner,
  candidateIds: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  const keys = await getEnabledByokProviders(readDb, owner);
  if (keys.length === 0) return new Set();
  const enabledProviderIds = new Set(keys.map(key => key.providerId));
  const catalogModelIds = await getDirectByokCatalogModelIds(owner);
  const served = await Promise.all(
    candidateIds.map(async modelId => {
      if (catalogModelIds.has(modelId)) return true;
      const directByok = await getDirectByokModel(modelId);
      if (directByok) return enabledProviderIds.has(directByok.provider.id);
      if (await isCustomLlm(modelId)) return false;
      return hasEnabledUserByokForModel({
        modelId,
        modelProviders: await getModelUserByokProviders(modelId, enabledProviderIds),
        enabledProviderIds,
        allowedProviders: undefined,
      });
    })
  );
  return new Set(candidateIds.filter((_modelId, index) => served[index]));
}

/**
 * The candidates an organization's inference region rules out: Kilo pays for them only through its
 * Vercel AI Gateway route pinned to the region, so a model Vercel cannot pin there, or a custom LLM,
 * fails unless the owner's own BYOK key serves it. Auto routing denies these so it never picks a
 * model the request then fails on. Without `byokOwner`, BYOK keys are not considered.
 */
export async function inferenceRegionIneligibleCandidates(params: {
  region: OrganizationDataRegion;
  candidateIds: ReadonlyArray<string>;
  byokOwner: ByokOwner | null;
}): Promise<string[]> {
  const { region, byokOwner } = params;
  const candidateIds = [...new Set(params.candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const eligible = await Promise.all(
    candidateIds.map(
      async modelId =>
        !(await isCustomLlm(modelId)) && (await isVercelModelInInferenceRegion(modelId, region))
    )
  );
  const outsideRegion = candidateIds.filter((_modelId, index) => !eligible[index]);
  if (outsideRegion.length === 0 || !byokOwner) return outsideRegion;
  const servedByByok = await candidatesServedByOwnerByok(byokOwner, outsideRegion);
  return outsideRegion.filter(modelId => !servedByByok.has(modelId));
}
