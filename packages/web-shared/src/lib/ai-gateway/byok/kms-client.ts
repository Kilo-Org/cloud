import { CompactEncrypt } from 'jose';
import { z } from 'zod';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

const KMS_REQUEST_TIMEOUT_MS = 5000;
const TRANSPORT_HEADER_VERSION = 1;

export type ByokKmsContext = {
  owner_type: 'user' | 'organization';
  owner_id: string;
  provider_id: string;
};

type ByokKmsClientConfig = {
  url: string;
  token: string;
  transportKey: Uint8Array;
};

const EnvelopeSchema = z.object({
  encrypted_data: z.object({ iv: z.string(), data: z.string(), authTag: z.string() }),
  wrapped_dek: z.string().min(1),
  kms_key_id: z.string().min(1),
  kms_key_version: z.string().min(1),
  algorithm: z.literal('aes-256-gcm'),
  envelope_version: z.literal(1),
});

const DecryptResponseSchema = z.object({ dek: z.string().min(1) });

export function getByokKmsClientConfig(): ByokKmsClientConfig | null {
  const url = getEnvVariable('BYOK_KMS_SERVICE_URL');
  if (!url) return null;

  const token = getEnvVariable('BYOK_KMS_SERVICE_TOKEN');
  if (!token)
    throw new Error('BYOK_KMS_SERVICE_TOKEN is required when BYOK_KMS_SERVICE_URL is set');

  const transportKeyBase64 =
    getEnvVariable('BYOK_KMS_TRANSPORT_ENCRYPTION_KEY') || getEnvVariable('BYOK_ENCRYPTION_KEY');
  const transportKey = Buffer.from(transportKeyBase64 ?? '', 'base64');
  if (transportKey.length !== 32) {
    throw new Error('BYOK KMS transport encryption key must be 32 bytes (256 bits)');
  }

  return { url: url.replace(/\/+$/, ''), token, transportKey: new Uint8Array(transportKey) };
}

async function postToKms(config: ByokKmsClientConfig, path: string, body: unknown) {
  const response = await fetch(`${config.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(KMS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`BYOK KMS ${path} failed with status ${response.status}`);
  }
  return response.json();
}

export async function encryptByokForStorage({
  apiKey,
  context,
}: {
  apiKey: string;
  context: ByokKmsContext;
}): Promise<BYOKApiKeyEnvelope | null> {
  const config = getByokKmsClientConfig();
  if (!config) return null;

  const jwe = await new CompactEncrypt(new TextEncoder().encode(apiKey))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', v: TRANSPORT_HEADER_VERSION, ...context })
    .encrypt(config.transportKey);

  return EnvelopeSchema.parse(await postToKms(config, '/encrypt', { jwe }));
}

export async function decryptByokEnvelope(
  envelope: BYOKApiKeyEnvelope,
  context: ByokKmsContext
): Promise<string> {
  const config = getByokKmsClientConfig();
  if (!config) {
    throw new Error('BYOK_KMS_SERVICE_URL is required to decrypt an envelope-encrypted BYOK key');
  }

  const { dek } = DecryptResponseSchema.parse(
    await postToKms(config, '/decrypt', {
      wrapped_dek: envelope.wrapped_dek,
      kms_key_id: envelope.kms_key_id,
      kms_key_version: envelope.kms_key_version,
      context,
    })
  );
  return decryptApiKey(envelope.encrypted_data, dek);
}
