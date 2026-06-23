import { type db } from '@/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  UserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  type UserByokProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@/lib/ai-gateway/providers/mistral';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import { getVercelModelsMetadata } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/models';

export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  const vercelModelMetadata = await getVercelModelsMetadata();
  if (Object.keys(vercelModelMetadata).length === 0) {
    console.error('[getModelUserByokProviders] no Vercel model metadata for model %s', modelId);
    return [];
  }
  const providers: UserByokProviderId[] =
    vercelModelMetadata[mapModelIdToVercel(modelId, false)]?.endpoints
      .map(ep => VercelUserByokInferenceProviderIdSchema.safeParse(ep.provider_name ?? ep.tag).data)
      .filter(providerId => providerId !== undefined) ?? [];
  if (providers.length === 0) {
    console.debug(`[getModelUserByokProviders] no user byok providers for ${modelId}`);
    return [];
  }
  if (isCodestralModel(modelId)) {
    providers.unshift('codestral');
  }
  console.debug('[getModelUserByokProviders] found user byok providers for %s', modelId, providers);
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

  return rows.map(row => UserByokProviderIdSchema.parse(row.provider_id));
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

  return rows.map(row => UserByokProviderIdSchema.parse(row.provider_id));
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
  fromDb: typeof db,
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
