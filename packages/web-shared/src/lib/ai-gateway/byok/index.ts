import { type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { ByokApiKeySettingsSchema } from '@kilocode/db/schema-types';
import { and, eq, inArray } from 'drizzle-orm';
import type { EncryptedData } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';

// A BYOK key belongs to exactly one owner, either a user or an organization.
type ByokOwnerColumn = typeof byok_api_keys.kilo_user_id | typeof byok_api_keys.organization_id;
type ByokSourceDb = typeof db | DrizzleTransaction;

async function deriveModelInferenceUserByokProviders(
  modelId: string,
  vercelModelMetadata: StoredModelMap
): Promise<UserByokProviderId[]> {
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
 * take them over. Custom LLMs are never in the gateway catalogs, so the
 * built-in free rules suffice.
 */
async function getModelGatewayUserByokProviders(
  modelId: string
): Promise<GatewayUserByokProviderId[]> {
  if (isKiloExclusiveModel(modelId) || isFreeModelExcludingCustomLlms(modelId)) {
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

/**
 * Returns every user BYOK provider whose key can serve `modelId`: first the
 * inference providers routed through Vercel, then the gateway keys in order of
 * preference.
 */
export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  const [vercelModelMetadata, gatewayProviders] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    getModelGatewayUserByokProviders(modelId),
  ]);
  if (Object.keys(vercelModelMetadata).length === 0) {
    console.error('[getModelUserByokProviders] no Vercel model metadata for model %s', modelId);
    return gatewayProviders;
  }
  return [
    ...(await deriveModelInferenceUserByokProviders(modelId, vercelModelMetadata)),
    ...gatewayProviders,
  ];
}

export type ByokOwner = { type: 'user'; id: string } | { type: 'organization'; id: string };

export function byokOwner(userId: string, organizationId: string | null | undefined): ByokOwner {
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: userId };
}

function ownerColumn(owner: ByokOwner): ByokOwnerColumn {
  return owner.type === 'organization' ? byok_api_keys.organization_id : byok_api_keys.kilo_user_id;
}

/** Whether stored key settings put the key in catalog mode. */
export function servesCatalogModels(settings: unknown): boolean {
  const parsed = ByokApiKeySettingsSchema.safeParse(settings);
  return parsed.success && parsed.data.serve_catalog_models === true;
}

export type EnabledByokProvider = {
  providerId: UserByokProviderId;
  /** Catalog mode as stored. */
  serveCatalogModels: boolean;
};

export async function getEnabledByokProviders(
  fromDb: ByokSourceDb,
  owner: ByokOwner
): Promise<EnabledByokProvider[]> {
  const rows = await fromDb
    .select({
      provider_id: byok_api_keys.provider_id,
      settings: byok_api_keys.settings,
    })
    .from(byok_api_keys)
    .where(and(eq(ownerColumn(owner), owner.id), eq(byok_api_keys.is_enabled, true)));

  return rows.flatMap(row => {
    const providerId = UserByokProviderIdSchema.safeParse(row.provider_id);
    return providerId.success
      ? [{ providerId: providerId.data, serveCatalogModels: servesCatalogModels(row.settings) }]
      : [];
  });
}

export async function getUserByokProviderIds(
  fromDb: typeof db,
  userId: string
): Promise<UserByokProviderId[]> {
  const providers = await getEnabledByokProviders(fromDb, { type: 'user', id: userId });
  return providers.map(provider => provider.providerId);
}

export async function getOrganizationByokProviderIds(
  fromDb: typeof db,
  organizationId: string
): Promise<UserByokProviderId[]> {
  const providers = await getEnabledByokProviders(fromDb, {
    type: 'organization',
    id: organizationId,
  });
  return providers.map(provider => provider.providerId);
}

export async function addUserByokAvailability(
  models: OpenRouterModel[],
  enabledProviderIds: UserByokProviderId[]
): Promise<OpenRouterModel[]> {
  const enabledProviders = new Set(enabledProviderIds);
  const vercelModelMetadata = await getVercelModelsMetadataFromDatabase();
  const hasMetadata = Object.keys(vercelModelMetadata).length > 0;
  if (!hasMetadata) {
    console.error('[addUserByokAvailability] no Vercel model metadata');
  }
  return Promise.all(
    models.map(async model => {
      if (isKiloExclusiveModel(model.id)) {
        return { ...model, hasUserByokAvailable: false };
      }
      const modelProviders = [
        ...(hasMetadata
          ? await deriveModelInferenceUserByokProviders(model.id, vercelModelMetadata)
          : []),
        ...(await getModelGatewayUserByokProviders(model.id)),
      ];
      const hasUserByokAvailable = modelProviders.some(provider => enabledProviders.has(provider));
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

export type ByokCredential = BYOKResult & { serveCatalogModels: boolean };

/** The owner's enabled keys for `providerIds`, oldest first. */
export async function getByokCredentials(
  fromDb: ByokSourceDb,
  owner: ByokOwner,
  providerIds: UserByokProviderId[]
): Promise<ByokCredential[]> {
  if (providerIds.length === 0) {
    return [];
  }
  const rows = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
      settings: byok_api_keys.settings,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(ownerColumn(owner), owner.id),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  return rows.map(row => ({
    ...decryptByokRow(row),
    serveCatalogModels: servesCatalogModels(row.settings),
  }));
}

async function getByokRowsForOwner(
  fromDb: ByokSourceDb,
  owner: ByokOwner,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  const credentials = await getByokCredentials(fromDb, owner, providerIds);
  return credentials.length === 0
    ? null
    : credentials.map(({ decryptedAPIKey, providerId }) => ({ decryptedAPIKey, providerId }));
}

export async function getBYOKforUser(
  fromDb: typeof db,
  userId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  return getByokRowsForOwner(fromDb, { type: 'user', id: userId }, providerIds);
}

export async function getBYOKforOrganization(
  fromDb: typeof db | DrizzleTransaction,
  organizationId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  return getByokRowsForOwner(fromDb, { type: 'organization', id: organizationId }, providerIds);
}
