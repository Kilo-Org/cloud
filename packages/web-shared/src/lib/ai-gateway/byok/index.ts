import { type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { ByokApiKeySettingsSchema } from '@kilocode/db/schema-types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { BYOKApiKeyEnvelope, EncryptedData } from '@kilocode/db/schema-types';
import {
  decryptByokEnvelope,
  getByokKmsClientConfig,
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
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

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
  /** Catalog mode as stored; only providers that support it can store true. */
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

/**
 * Whether an inference provider key among `enabledProviderIds` serves `modelId`, as `getProvider`
 * routes it: a direct BYOK key in catalog mode (`directByokCatalogModelIds`), or a provider key
 * sent through Vercel. Gateway keys leave the choice of provider to the gateway, so they do not
 * count, and neither does any key for an id a custom LLM owns, which `getProvider` serves first.
 */
export async function hasInferenceProviderByokForModel(
  modelId: string,
  enabledProviderIds: readonly UserByokProviderId[],
  directByokCatalogModelIds: ReadonlySet<string>
): Promise<boolean> {
  if (await isCustomLlm(modelId)) return false;
  if (directByokCatalogModelIds.has(modelId)) return true;
  if (isKiloExclusiveModel(modelId) || enabledProviderIds.every(isGatewayUserByokProviderId)) {
    return false;
  }
  const modelProviders = await getModelInferenceUserByokProviders(modelId);
  return modelProviders.some(providerId => enabledProviderIds.includes(providerId));
}

/** Whether `userByok` are inference provider keys rather than a gateway key. */
export function isInferenceProviderByok(userByok: readonly BYOKResult[] | null): boolean {
  return (
    userByok !== null &&
    userByok.length > 0 &&
    !userByok.some(byok => isGatewayUserByokProviderId(byok.providerId))
  );
}

/**
 * Marks catalog models the caller's direct BYOK keys in catalog mode serve
 * (`getDirectByokCatalogModelIds`), alongside the gateway and Vercel BYOK availability.
 */
export function addDirectByokCatalogAvailability(
  models: OpenRouterModel[],
  directByokCatalogModelIds: ReadonlySet<string>
): OpenRouterModel[] {
  if (directByokCatalogModelIds.size === 0) return models;
  return models.map(model =>
    directByokCatalogModelIds.has(model.id) ? { ...model, hasUserByokAvailable: true } : model
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
  // The legacy column is always written alongside the envelope, so with the KMS service
  // unconfigured (rollback) it is still valid and we read it instead of failing.
  const decryptedAPIKey =
    row.encrypted_api_key_envelope && getByokKmsClientConfig()
      ? await decryptByokEnvelope(row.encrypted_api_key_envelope, getByokKmsContext(row))
      : decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  return {
    decryptedAPIKey,
    providerId: UserByokProviderIdSchema.parse(row.provider_id),
  };
}

export type ByokCredential = BYOKResult & { serveCatalogModels: boolean };

/** The owner's enabled keys for `providerIds`, oldest first; `catalogModeOnly` keeps catalog-mode keys. */
export async function getByokCredentials(
  fromDb: ByokSourceDb,
  owner: ByokOwner,
  providerIds: UserByokProviderId[],
  { catalogModeOnly = false }: { catalogModeOnly?: boolean } = {}
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
        inArray(byok_api_keys.provider_id, providerIds),
        // Filtering before decryption keeps keys that cannot serve the request out of the KMS
        // round-trips and out of the fail-closed decryption check below.
        catalogModeOnly
          ? sql`(${byok_api_keys.settings}->>'serve_catalog_models')::boolean is true`
          : undefined
      )
    )
    .orderBy(byok_api_keys.created_at);

  const results = await Promise.allSettled(
    rows.map(async row => ({
      ...(await decryptByokRow(row)),
      serveCatalogModels: servesCatalogModels(row.settings),
    }))
  );

  const credentials: ByokCredential[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') credentials.push(result.value);
    else failures.push(result.reason);
  }
  for (const failure of failures) captureException(failure);

  // Fail closed when no key could be decrypted so the request never falls back to Kilo-paid routing.
  if (credentials.length === 0 && failures.length > 0) throw failures[0];
  return credentials;
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
