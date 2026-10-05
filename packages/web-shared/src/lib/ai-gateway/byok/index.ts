import { type db, type DrizzleTransaction } from '@/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@/lib/ai-gateway/providers/mistral';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import {
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/kilo-exclusive-models';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { hasEnabledUserByokForModel } from '@/lib/ai-gateway/byok/availability';

/**
 * Returns every user BYOK provider whose key can serve `modelId`: first the
 * inference providers routed through Vercel, then the gateway keys in order of
 * preference.
 */
export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  const [inferenceProviders, gatewayProviders] = await Promise.all([
    getModelInferenceUserByokProviders(modelId),
    getModelGatewayUserByokProviders(modelId),
  ]);
  return [...inferenceProviders, ...gatewayProviders];
}

async function getModelInferenceUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  const vercelModelMetadata = await getVercelModelsMetadataFromDatabase();
  if (Object.keys(vercelModelMetadata).length === 0) {
    console.error('[getModelUserByokProviders] no Vercel model metadata for model %s', modelId);
    return [];
  }
  const providers: UserByokProviderId[] = [
    ...new Set(
      vercelModelMetadata[await mapModelIdToVercel(modelId)]?.endpoints
        .map(ep => getVercelUserByokProviderIdForEndpoint(ep.provider_name ?? ep.tag))
        .filter(providerId => providerId !== undefined) ?? []
    ),
  ];
  if (providers.length === 0) {
    console.debug(`[getModelUserByokProviders] no user byok providers for ${modelId}`);
    return [];
  }
  if (isCodestralModel(modelId)) {
    providers.unshift('codestral');
  }
  return providers;
}

/**
 * Kilo-exclusive and free models stay on Kilo's own accounts: they are served
 * through Kilo-specific routes or paid for by Kilo, so a gateway key must not
 * take them over.
 */
export async function getModelGatewayUserByokProviders(
  modelId: string
): Promise<GatewayUserByokProviderId[]> {
  if (isKiloExclusiveModel(modelId) || isFreeModel(modelId)) {
    return [];
  }
  const [vercelModels, vercelModelId, isOpenRouterModel] = await Promise.all([
    getVercelModelsFromDatabase(),
    mapModelIdToVercel(modelId),
    isValidOpenRouterModelId(modelId),
  ]);
  return GatewayUserByokProviderIdSchema.options.filter(providerId =>
    providerId === 'vercel-ai-gateway' ? vercelModels.has(vercelModelId) : isOpenRouterModel
  );
}

export async function getUserByokProviderIds(
  fromDb: typeof db,
  userId: string
): Promise<UserByokProviderId[]> {
  const rows = await fromDb
    .select({ provider_id: byok_api_keys.provider_id })
    .from(byok_api_keys)
    .where(and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.is_enabled, true)));

  return parseUserByokProviderIds(rows);
}

export async function getOrganizationByokProviderIds(
  fromDb: typeof db,
  organizationId: string
): Promise<UserByokProviderId[]> {
  const rows = await fromDb
    .select({ provider_id: byok_api_keys.provider_id })
    .from(byok_api_keys)
    .where(
      and(eq(byok_api_keys.organization_id, organizationId), eq(byok_api_keys.is_enabled, true))
    );

  return parseUserByokProviderIds(rows);
}

function parseUserByokProviderIds(rows: { provider_id: string }[]): UserByokProviderId[] {
  return rows.flatMap(row => {
    const providerId = UserByokProviderIdSchema.safeParse(row.provider_id);
    return providerId.success ? [providerId.data] : [];
  });
}

/**
 * `getAllowedProviders` returns the organization's allowed providers for a
 * model, or undefined when every provider is allowed.
 */
export async function addUserByokAvailability(
  models: OpenRouterModel[],
  enabledProviderIds: UserByokProviderId[],
  getAllowedProviders: (modelId: string) => ReadonlySet<string> | undefined = () => undefined
): Promise<OpenRouterModel[]> {
  const enabledProviders = new Set(enabledProviderIds);
  return Promise.all(
    models.map(async model => {
      const hasUserByokAvailable =
        !isKiloExclusiveModel(model.id) &&
        (await hasEnabledUserByokForModel({
          modelId: model.id,
          modelProviders: await getModelUserByokProviders(model.id),
          enabledProviderIds: enabledProviders,
          allowedProviders: getAllowedProviders(model.id),
        }));
      return { ...model, hasUserByokAvailable };
    })
  );
}

export function decryptByokRow({
  encrypted_api_key,
  provider_id,
}: {
  encrypted_api_key: EncryptedData;
  provider_id: string;
}) {
  return {
    decryptedAPIKey: decryptApiKey(encrypted_api_key, BYOK_ENCRYPTION_KEY),
    providerId: UserByokProviderIdSchema.parse(provider_id),
  };
}

export async function getBYOKforUser(
  fromDb: typeof db,
  userId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  if (providerIds.length === 0) {
    return null;
  }
  const rows = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  return rows.length === 0 ? null : rows.map(row => decryptByokRow(row));
}

export async function getBYOKforOrganization(
  fromDb: typeof db | DrizzleTransaction,
  organizationId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  if (providerIds.length === 0) {
    return null;
  }
  const rows = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.organization_id, organizationId),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  return rows.length === 0 ? null : rows.map(row => decryptByokRow(row));
}
