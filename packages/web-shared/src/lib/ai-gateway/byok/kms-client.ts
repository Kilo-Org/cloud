import { z } from 'zod';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

const KMS_REQUEST_TIMEOUT_MS = 5000;

export type ByokKmsContext = {
  key_id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  provider_id: string;
};

type ByokKmsClientConfig = {
  url: string;
  token: string;
};

const CreatedDataKeySchema = z.object({
  data_key: z.string().min(1),
  wrapped_dek: z.string().min(1),
  kms_key_id: z.string().min(1),
  kms_key_version: z.string().min(1),
});

const RetrievedDataKeySchema = z.object({ data_key: z.string().min(1) });

export function getByokKmsClientConfig(): ByokKmsClientConfig | null {
  const url = getEnvVariable('BYOK_KMS_SERVICE_URL');
  if (!url) return null;

  const token = getEnvVariable('BYOK_KMS_SERVICE_TOKEN');
  if (!token)
    throw new Error('BYOK_KMS_SERVICE_TOKEN is required when BYOK_KMS_SERVICE_URL is set');

  return { url: url.replace(/\/+$/, ''), token };
}

async function sendToKms(config: ByokKmsClientConfig, url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { ...init.headers, authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(KMS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`BYOK KMS ${new URL(url).pathname} failed with status ${response.status}`);
  }
  return response.json();
}

export type ByokDataKey = z.infer<typeof CreatedDataKeySchema>;

/**
 * Requests a data key bound to `context`. The request carries identifiers only, never
 * the plaintext, so callers can issue it before the secret is available (for example
 * ahead of a database transaction) and encrypt later with `encryptByokWithDataKey`.
 */
export async function createByokDataKey({
  context,
  actorUserId,
}: {
  context: ByokKmsContext;
  actorUserId: string;
}): Promise<ByokDataKey | null> {
  const config = getByokKmsClientConfig();
  if (!config) return null;

  return CreatedDataKeySchema.parse(
    await sendToKms(config, `${config.url}/data-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...context, actor_user_id: actorUserId }),
    })
  );
}

export function encryptByokWithDataKey(apiKey: string, dataKey: ByokDataKey): BYOKApiKeyEnvelope {
  return {
    encrypted_data: encryptApiKey(apiKey, dataKey.data_key),
    wrapped_dek: dataKey.wrapped_dek,
    kms_key_id: dataKey.kms_key_id,
    kms_key_version: dataKey.kms_key_version,
    algorithm: 'aes-256-gcm',
    envelope_version: 1,
  };
}

export async function encryptByokForStorage({
  apiKey,
  context,
  actorUserId,
}: {
  apiKey: string;
  context: ByokKmsContext;
  actorUserId: string;
}): Promise<BYOKApiKeyEnvelope | null> {
  const dataKey = await createByokDataKey({ context, actorUserId });
  return dataKey ? encryptByokWithDataKey(apiKey, dataKey) : null;
}

export async function decryptByokEnvelope(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext
): Promise<string> {
  const config = getByokKmsClientConfig();
  if (!config) {
    throw new Error('BYOK_KMS_SERVICE_URL is required to decrypt an envelope-encrypted BYOK key');
  }

  const { data_key } = RetrievedDataKeySchema.parse(
    await sendToKms(config, `${config.url}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...context,
        wrapped_dek: envelope.wrapped_dek,
        kms_key_id: envelope.kms_key_id,
        kms_key_version: envelope.kms_key_version,
      }),
    })
  );
  return decryptApiKey(envelope.encrypted_data, data_key);
}
