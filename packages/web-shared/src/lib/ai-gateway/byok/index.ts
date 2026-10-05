import { type db, type DrizzleTransaction } from '@/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  UserByokProviderIdSchema,
  getVercelUserByokProviderIdForEndpoint,
  type UserByokProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@/lib/ai-gateway/providers/mistral';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import { getVercelModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/kilo-exclusive-models';

export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
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

export async function addUserByokAvailability(
  models: OpenRouterModel[],
  enabledProviderIds: UserByokProviderId[]
): Promise<OpenRouterModel[]> {
  const enabledProviders = new Set(enabledProviderIds);
  return Promise.all(
    models.map(async model => {
      const hasUserByokAvailable =
        !isKiloExclusiveModel(model.id) &&
        (await getModelUserByokProviders(model.id)).some(provider =>
          enabledProviders.has(provider)
        );
      return { ...model, hasUserByokAvailable };
    })
  );
}

export function decryptByokRow({
  encrypted_api_key,
  provider_id,
  base_url,
  display_name,
  provider_api,
}: {
  encrypted_api_key: EncryptedData;
  provider_id: string;
  base_url?: string | null;
  display_name?: string | null;
  provider_api?: string | null;
}): {
  decryptedAPIKey: string;
  providerId: string;
  baseUrl: string | null;
  displayName: string | null;
  providerApi: string | null;
} {
  const parsedProviderId = UserByokProviderIdSchema.safeParse(provider_id);
  return {
    decryptedAPIKey: decryptApiKey(encrypted_api_key, BYOK_ENCRYPTION_KEY),
    providerId: parsedProviderId.success ? parsedProviderId.data : provider_id,
    baseUrl: base_url ?? null,
    displayName: display_name ?? null,
    providerApi: provider_api ?? null,
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
      base_url: byok_api_keys.base_url,
      display_name: byok_api_keys.display_name,
      provider_api: byok_api_keys.provider_api,
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

export async function getAllBYOKRowsForUser(
  fromDb: typeof db,
  userId: string
): Promise<BYOKResult[] | null> {
  const rows = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
      base_url: byok_api_keys.base_url,
      display_name: byok_api_keys.display_name,
      provider_api: byok_api_keys.provider_api,
    })
    .from(byok_api_keys)
    .where(and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.is_enabled, true)))
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
      base_url: byok_api_keys.base_url,
      display_name: byok_api_keys.display_name,
      provider_api: byok_api_keys.provider_api,
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

export async function getAllBYOKRowsForOrganization(
  fromDb: typeof db | DrizzleTransaction,
  organizationId: string
): Promise<BYOKResult[] | null> {
  const rows = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
      base_url: byok_api_keys.base_url,
      display_name: byok_api_keys.display_name,
      provider_api: byok_api_keys.provider_api,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.organization_id, organizationId),
        eq(byok_api_keys.is_enabled, true)
      )
    )
    .orderBy(byok_api_keys.created_at);

  return rows.length === 0 ? null : rows.map(row => decryptByokRow(row));
}
