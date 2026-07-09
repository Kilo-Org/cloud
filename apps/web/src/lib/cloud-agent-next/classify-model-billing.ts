import 'server-only';
import { type db } from '@/lib/drizzle';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/models';
import {
  getModelUserByokProviders,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
} from '@/lib/ai-gateway/byok';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

/**
 * How a Cloud Agent session for a given model should be billed:
 * - `free`: Kilo-funded, no balance required.
 * - `byok`: served against the owner's own provider key, no balance required.
 * - `balance-required`: platform-billed, needs a positive credit balance.
 */
export type CloudAgentModelBilling = 'free' | 'byok' | 'balance-required';

/**
 * Classifies how a model would be billed for a given owner (a user, or an
 * organization when `organizationId` is set).
 *
 * This is the source-of-truth classifier that backs the worker-side balance
 * middleware: the cloud-agent-next worker runs in a Cloudflare Worker that
 * cannot import `apps/web`'s model catalog, so it asks this module over HTTP
 * (`POST /api/profile/cloud-agent-admission`) rather than re-deriving the catalog.
 *
 * Kilo-exclusive models (e.g. `deepseek/deepseek-v4-pro:discounted`) are always
 * `balance-required`: they are Kilo-funded and platform billed, so even when
 * `getModelUserByokProviders` reports a provider that could route the model,
 * they cannot be legitimately served via an owner's own BYOK key.
 */
export async function classifyCloudAgentModelBilling(params: {
  fromDb: typeof db;
  modelId: string;
  userId: string;
  organizationId?: string;
}): Promise<CloudAgentModelBilling> {
  if (await isFreeModel(params.modelId)) {
    return 'free';
  }

  if (isKiloExclusiveModel(params.modelId)) {
    return 'balance-required';
  }

  const directByok = await getDirectByokModel(params.modelId);
  if (directByok.provider && directByok.model) {
    const enabledProviderIds = await getEnabledProviderIds(params);
    return enabledProviderIds.includes(directByok.provider.id) ? 'byok' : 'balance-required';
  }

  const modelProviders = await getModelUserByokProviders(params.modelId);
  if (modelProviders.length === 0) {
    return 'balance-required';
  }

  const enabledProviderIds = await getEnabledProviderIds(params);

  const enabled = new Set(enabledProviderIds);
  return modelProviders.some(provider => enabled.has(provider)) ? 'byok' : 'balance-required';
}

function getEnabledProviderIds(params: {
  fromDb: typeof db;
  userId: string;
  organizationId?: string;
}): Promise<UserByokProviderId[]> {
  return params.organizationId
    ? getOrganizationByokProviderIds(params.fromDb, params.organizationId)
    : getUserByokProviderIds(params.fromDb, params.userId);
}
