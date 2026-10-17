import 'server-only';

import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import { CUSTOM_LLM_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

type EligibleModelInfo = {
  id: string;
};

export type EligibleCatalog = {
  byId: ReadonlyMap<string, EligibleModelInfo>;
  byokOnlyIds: ReadonlySet<string>;
  /** Managed catalog ids before org filtering (for org-denied classification). */
  managedIds: ReadonlySet<string>;
  /** Ids present in the owner-scoped catalog after org filtering. */
  ownerCatalogIds: ReadonlySet<string>;
  organizationId: string | null;
};

function isHiddenExclusiveModel(modelId: string): boolean {
  const exclusive = kiloExclusiveModels.find(model => model.public_id === modelId);
  return exclusive !== undefined && exclusive.status !== 'public';
}

/**
 * Build the eligible managed catalog for pool membership.
 * Client-side filtering is never trusted; this is the authorization source.
 */
export async function buildEligibleCatalog(params: {
  userId: string;
  organizationId: string | null;
}): Promise<EligibleCatalog> {
  const { userId, organizationId } = params;

  const [enhanced, byokModels] = await Promise.all([
    getEnhancedOpenRouterModels(),
    organizationId
      ? getDirectByokModelsForOrganization(organizationId)
      : getDirectByokModelsForUser(userId),
  ]);

  const managedModels = Array.isArray(enhanced.data) ? enhanced.data : [];
  const managedIds = new Set(managedModels.map(model => model.id));
  const byokOnlyIds = new Set(byokModels.map(model => model.id));

  let ownerModels: OpenRouterModel[];
  if (organizationId) {
    // Pool membership is organization-level configuration, so it resolves against
    // the organization's own policy rather than the configuring owner's group
    // grants. A member subject would also require direct membership, which a
    // parent-organization owner or platform admin may not have.
    const orgCatalog = await getAvailableModelsForOrganization(organizationId, {
      type: 'defaultAccess',
    });
    ownerModels = orgCatalog?.data ?? [];
  } else {
    ownerModels = managedModels;
  }

  const ownerCatalogIds = new Set(ownerModels.map(model => model.id));
  const byId = new Map<string, EligibleModelInfo>();

  for (const model of ownerModels) {
    const id = model.id;
    if (isVirtualAutoModelId(id)) continue;
    if (byokOnlyIds.has(id)) continue;
    if (id.startsWith(CUSTOM_LLM_PREFIX)) continue;
    if (isHiddenExclusiveModel(id)) continue;

    byId.set(id, { id });
  }

  return {
    byId,
    byokOnlyIds,
    managedIds,
    ownerCatalogIds,
    organizationId,
  };
}
