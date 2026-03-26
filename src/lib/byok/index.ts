import { readDb, type db } from '@/lib/drizzle';
import { byok_api_keys, modelsByProvider } from '@kilocode/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { EncryptedData } from '@/lib/byok/encryption';
import { decryptApiKey } from '@/lib/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  UserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  type UserByokProviderId,
} from '@/lib/providers/openrouter/inference-provider-id';
import { isCodestralModel } from '@/lib/providers/mistral';
import { unstable_cache } from 'next/cache';
import { mapModelIdToVercel } from '@/lib/providers/vercel/mapModelIdToVercel';
import type { BYOKResult } from '@/lib/providers/types';

const getModelUserByokProviders_cached = unstable_cache(
  async (modelId: string) => {
    const vercelModelMetadata = (
      await readDb
        .select({ vercel: modelsByProvider.vercel })
        .from(modelsByProvider)
        .orderBy(desc(modelsByProvider.id))
        .limit(1)
    ).at(0)?.vercel;
    if (!vercelModelMetadata) {
      console.error('[getModelUserByokProviders_cached] no Vercel model metadata in the database');
      return [];
    }
    const providers =
      vercelModelMetadata[mapModelIdToVercel(modelId)]?.endpoints
        .map(ep => VercelUserByokInferenceProviderIdSchema.safeParse(ep.tag).data)
        .filter(providerId => providerId !== undefined) ?? [];
    if (providers.length === 0) {
      console.debug(`[getModelUserByokProviders_cached] no user byok providers for ${modelId}`);
      return [];
    }
    console.debug(
      `[getModelUserByokProviders_cached] found user byok providers for ${modelId}`,
      providers
    );
    return providers;
  },
  undefined,
  { revalidate: 300 }
);

export async function getModelUserByokProviders(model: string): Promise<UserByokProviderId[]> {
  return isCodestralModel(model) ? ['codestral'] : await getModelUserByokProviders_cached(model);
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
