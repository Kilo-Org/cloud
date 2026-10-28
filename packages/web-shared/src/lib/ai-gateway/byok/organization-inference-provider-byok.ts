import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getOrganizationByokProviderIds,
  hasInferenceProviderByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';

/** The models among `modelIds` that the organization's inference provider keys serve. */
export async function modelsServedByOrganizationInferenceProviderByok(
  organizationId: string,
  modelIds: readonly string[]
): Promise<string[]> {
  if (modelIds.length === 0) return [];
  const [providerIds, catalogModelIds] = await Promise.all([
    getOrganizationByokProviderIds(readDb, organizationId),
    getDirectByokCatalogModelIds({ type: 'organization', id: organizationId }),
  ]);
  const served = await Promise.all(
    modelIds.map(modelId => hasInferenceProviderByokForModel(modelId, providerIds, catalogModelIds))
  );
  return modelIds.filter((_modelId, index) => served[index]);
}
