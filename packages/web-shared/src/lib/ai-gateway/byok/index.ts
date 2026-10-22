import { type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { EncryptedData } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import {
  UserByokProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  getVercelModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

// A BYOK key belongs to exactly one owner, either a user or an organization.
type ByokOwnerColumn = typeof byok_api_keys.kilo_user_id | typeof byok_api_keys.organization_id;
type ByokSourceDb = typeof db | DrizzleTransaction;

async function deriveModelUserByokProviders(
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

export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  const vercelModelMetadata = await getVercelModelsMetadataFromDatabase();
  if (Object.keys(vercelModelMetadata).length === 0) {
    console.error('[getModelUserByokProviders] no Vercel model metadata for model %s', modelId);
    return [];
  }
  return deriveModelUserByokProviders(modelId, vercelModelMetadata);
}

async function getEnabledByokProviderIds(
  fromDb: ByokSourceDb,
  ownerColumn: ByokOwnerColumn,
  ownerId: string
): Promise<UserByokProviderId[]> {
  const rows = await fromDb
    .select({ provider_id: byok_api_keys.provider_id })
    .from(byok_api_keys)
    .where(and(eq(ownerColumn, ownerId), eq(byok_api_keys.is_enabled, true)));

  return parseUserByokProviderIds(rows);
}

export async function getUserByokProviderIds(
  fromDb: typeof db,
  userId: string
): Promise<UserByokProviderId[]> {
  return getEnabledByokProviderIds(fromDb, byok_api_keys.kilo_user_id, userId);
}

export async function getOrganizationByokProviderIds(
  fromDb: typeof db,
  organizationId: string
): Promise<UserByokProviderId[]> {
  return getEnabledByokProviderIds(fromDb, byok_api_keys.organization_id, organizationId);
}

function parseUserByokProviderIds(rows: { provider_id: string }[]): UserByokProviderId[] {
  return rows.flatMap(row => {
    const providerId = UserByokProviderIdSchema.safeParse(row.provider_id);
    return providerId.success ? [providerId.data] : [];
  });
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
      const hasUserByokAvailable =
        hasMetadata &&
        !isKiloExclusiveModel(model.id) &&
        (await deriveModelUserByokProviders(model.id, vercelModelMetadata)).some(provider =>
          enabledProviders.has(provider)
        );
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

async function getByokRowsForOwner(
  fromDb: ByokSourceDb,
  ownerColumn: ByokOwnerColumn,
  ownerId: string,
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
        eq(ownerColumn, ownerId),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  return rows.length === 0 ? null : rows.map(row => decryptByokRow(row));
}

export async function getBYOKforUser(
  fromDb: typeof db,
  userId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  return getByokRowsForOwner(fromDb, byok_api_keys.kilo_user_id, userId, providerIds);
}

export async function getBYOKforOrganization(
  fromDb: typeof db | DrizzleTransaction,
  organizationId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
  return getByokRowsForOwner(fromDb, byok_api_keys.organization_id, organizationId, providerIds);
}
