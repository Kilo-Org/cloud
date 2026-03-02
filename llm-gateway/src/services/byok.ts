import { createDecipheriv } from 'crypto';
import { byok_api_keys, modelsByProvider } from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import {
  UserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  isCodestralModel,
  kiloFreeModels,
  inferVercelFirstPartyInferenceProviderForModel,
  type UserByokProviderId,
  type VercelUserByokInferenceProviderId,
} from '@kilocode/llm-shared';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { WorkerDb } from '../lib/db.js';
import { logger } from '../logger.js';

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
};

// --- Encryption (ported to use Node.js crypto via nodejs_compat) ---

function decryptApiKey(encrypted: EncryptedData, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (256 bits)');
  }

  const iv = Buffer.from(encrypted.iv, 'base64');
  const encryptedData = Buffer.from(encrypted.data, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// --- Model ID mapping (inline port from vercel/mapModelIdToVercel.ts) ---

const vercelModelIdMapping: Record<string, string | undefined> = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
};

function mapModelIdToVercel(modelId: string): string {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) {
    return hardcodedVercelId;
  }

  const internalId =
    kiloFreeModels.find(m => m.public_id === modelId && m.is_enabled && m.gateway === 'openrouter')
      ?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}

// --- BYOK provider resolution with KV caching ---

async function getModelUserByokProviders_fromDb(
  modelId: string,
  db: WorkerDb
): Promise<UserByokProviderId[]> {
  const vercelModelMetadata = (
    await db
      .select({ vercel: modelsByProvider.vercel })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1)
  ).at(0)?.vercel;

  if (!vercelModelMetadata) {
    logger.error('no Vercel model metadata in the database');
    return [];
  }

  const vercelModelId = mapModelIdToVercel(modelId);
  const endpoints = vercelModelMetadata[vercelModelId]?.endpoints;

  const providers: UserByokProviderId[] =
    endpoints
      ?.map(ep => VercelUserByokInferenceProviderIdSchema.safeParse(ep.tag).data)
      .filter(
        (providerId): providerId is VercelUserByokInferenceProviderId => providerId !== undefined
      ) ?? [];

  if (providers.length === 0) {
    logger.debug(`no user byok providers for ${modelId}`);
    return [];
  }

  logger.debug(`found user byok providers for ${modelId}: ${providers.join(', ')}`);
  return providers;
}

export async function getModelUserByokProviders(
  model: string,
  db: WorkerDb,
  kv: KVNamespace
): Promise<UserByokProviderId[]> {
  if (isCodestralModel(model)) {
    return ['codestral'];
  }

  const cacheKey = `byok-providers:${model}`;
  const cached = await kv.get(cacheKey, 'json');
  if (cached) {
    return cached as UserByokProviderId[];
  }

  const providers = await getModelUserByokProviders_fromDb(model, db);
  await kv.put(cacheKey, JSON.stringify(providers), { expirationTtl: 300 });
  return providers;
}

function decryptByokRow(
  row: { encrypted_api_key: EncryptedData; provider_id: string },
  encryptionKey: string
): BYOKResult {
  return {
    decryptedAPIKey: decryptApiKey(row.encrypted_api_key, encryptionKey),
    providerId: UserByokProviderIdSchema.parse(row.provider_id),
  };
}

export async function getBYOKforUser(
  db: WorkerDb,
  userId: string,
  providerIds: UserByokProviderId[],
  encryptionKey: string
): Promise<BYOKResult[] | null> {
  const rows = await db
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

  return rows.map(row => decryptByokRow(row, encryptionKey));
}

export async function getBYOKforOrganization(
  db: WorkerDb,
  organizationId: string,
  providerIds: UserByokProviderId[],
  encryptionKey: string
): Promise<BYOKResult[] | null> {
  const rows = await db
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

  return rows.map(row => decryptByokRow(row, encryptionKey));
}
