import { type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { ByokApiKeySettingsSchema } from '@kilocode/db/schema-types';
import { and, eq, inArray } from 'drizzle-orm';
import type { BYOKApiKeyEnvelope, EncryptedData } from '@kilocode/db/schema-types';
import {
  decryptByokEnvelope,
  type ByokKmsContext,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  isGatewayUserByokProviderId,
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
import { hasEnabledUserByokForModel } from '@kilocode/web-shared/lib/ai-gateway/byok/availability';

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
export function isGatewayUserByokEligibleModel(modelId: string): boolean {
  return !isKiloExclusiveModel(modelId) && !isFreeModelExcludingCustomLlms(modelId);
}

export async function getModelGatewayUserByokProviders(
  modelId: string
): Promise<GatewayUserByokProviderId[]> {
  if (!isGatewayUserByokEligibleModel(modelId)) {
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

async function getVercelModelMetadata(caller: string): Promise<StoredModelMap | null> {
  const vercelModelMetadata = await getVercelModelsMetadataFromDatabase();
  if (Object.keys(vercelModelMetadata).length === 0) {
    console.error('[%s] no Vercel model metadata', caller);
    return null;
  }
  return vercelModelMetadata;
}

/** The inference providers routed through Vercel whose key can serve `modelId`. */
export async function getModelInferenceUserByokProviders(
  modelId: string
): Promise<UserByokProviderId[]> {
  const vercelModelMetadata = await getVercelModelMetadata('getModelInferenceUserByokProviders');
  return vercelModelMetadata
    ? deriveModelInferenceUserByokProviders(modelId, vercelModelMetadata)
    : [];
}

/**
 * Returns every user BYOK provider whose key can serve `modelId`: first the
 * inference providers routed through Vercel, then the gateway keys in order of
 * preference. With `enabledProviderIds`, skips the catalog lookups that cannot
 * match an enabled key.
 */
export async function getModelUserByokProviders(
  modelId: string,
  enabledProviderIds?: ReadonlySet<UserByokProviderId>
): Promise<UserByokProviderId[]> {
  const enabled = enabledProviderIds ? [...enabledProviderIds] : undefined;
  const [inferenceProviders, gatewayProviders] = await Promise.all([
    !enabled || enabled.some(id => !isGatewayUserByokProviderId(id))
      ? getModelInferenceUserByokProviders(modelId)
      : [],
    !enabled || enabled.some(isGatewayUserByokProviderId)
      ? getModelGatewayUserByokProviders(modelId)
      : [],
  ]);
  return [...inferenceProviders, ...gatewayProviders];
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
  const enabled = [...enabledProviders];
  const vercelModelMetadata = enabled.some(id => !isGatewayUserByokProviderId(id))
    ? await getVercelModelMetadata('addUserByokAvailability')
    : null;
  const hasGatewayKey = enabled.some(isGatewayUserByokProviderId);
  return Promise.all(
    models.map(async model => {
      if (enabledProviders.size === 0 || isKiloExclusiveModel(model.id)) {
        return { ...model, hasUserByokAvailable: false };
      }
      const modelProviders = [
        ...(vercelModelMetadata
          ? await deriveModelInferenceUserByokProviders(model.id, vercelModelMetadata)
          : []),
        ...(hasGatewayKey ? await getModelGatewayUserByokProviders(model.id) : []),
      ];
      const hasUserByokAvailable = await hasEnabledUserByokForModel({
        modelId: model.id,
        modelProviders,
        enabledProviderIds: enabledProviders,
        allowedProviders: getAllowedProviders(model.id),
      });
      return { ...model, hasUserByokAvailable };
    })
  );
}

export function getByokKmsContext(row: {
  id: string;
  organization_id: string | null;
  kilo_user_id: string | null;
  provider_id: string;
}): ByokKmsContext {
  if (row.organization_id) {
    return {
      key_id: row.id,
      owner_type: 'organization',
      owner_id: row.organization_id,
      provider_id: row.provider_id,
    };
  }
  if (row.kilo_user_id) {
    return {
      key_id: row.id,
      owner_type: 'user',
      owner_id: row.kilo_user_id,
      provider_id: row.provider_id,
    };
  }
  throw new Error('BYOK row has no owner');
}

export async function decryptByokRow(row: {
  id: string;
  encrypted_api_key: EncryptedData;
  encrypted_api_key_envelope: BYOKApiKeyEnvelope | null;
  organization_id: string | null;
  kilo_user_id: string | null;
  provider_id: string;
}) {
  const decryptedAPIKey = row.encrypted_api_key_envelope
    ? await decryptByokEnvelope(row.encrypted_api_key_envelope, getByokKmsContext(row))
    : decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  return {
    decryptedAPIKey,
    providerId: UserByokProviderIdSchema.parse(row.provider_id),
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
      id: byok_api_keys.id,
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      encrypted_api_key_envelope: byok_api_keys.encrypted_api_key_envelope,
      organization_id: byok_api_keys.organization_id,
      kilo_user_id: byok_api_keys.kilo_user_id,
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

  return Promise.all(
    rows.map(async row => ({
      ...(await decryptByokRow(row)),
      serveCatalogModels: servesCatalogModels(row.settings),
    }))
  );
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
