import { type db } from '@/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
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
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';
import { StoredModelSchema } from '@kilocode/db';
import * as z from 'zod';
import { createCachedFetch } from '@/lib/cached-fetch';

const getVercelMetadataCached = createCachedFetch(
  async () =>
    z
      .record(z.string(), StoredModelSchema)
      .parse(JSON.parse((await redisGet(GATEWAY_METADATA_REDIS_KEYS.vercelModels)) ?? '{}')),
  60_000,
  {}
);

export async function getModelUserByokProviders(modelId: string): Promise<UserByokProviderId[]> {
  if (isCodestralModel(modelId)) {
    return ['codestral'];
  }
  const vercelModelMetadata = await getVercelMetadataCached();
  if (Object.keys(vercelModelMetadata).length == 0) {
    console.error('[getModelUserByokProviders] no Vercel model metadata in the database');
    return [];
  }
  const providers =
    vercelModelMetadata[mapModelIdToVercel(modelId, false)]?.endpoints
      .map(ep => VercelUserByokInferenceProviderIdSchema.safeParse(ep.tag).data)
      .filter(providerId => providerId !== undefined) ?? [];
  if (providers.length === 0) {
    console.debug(`[getModelUserByokProviders] no user byok providers for ${modelId}`);
    return [];
  }
  console.debug(`[getModelUserByokProviders] found user byok providers for ${modelId}`, providers);
  return providers;
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

  if (rows.length === 0) {
    return null;
  }

  return rows.map(row => decryptByokRow(row));
}

export async function getBYOKforOrganization(
  fromDb: typeof db,
  organizationId: string,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[] | null> {
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

  if (rows.length === 0) {
    return null;
  }

  return rows.map(row => decryptByokRow(row));
}
