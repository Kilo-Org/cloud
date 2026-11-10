import { createCipheriv, randomBytes } from 'node:crypto';

import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';

type ByokKmsContext = {
  key_id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  provider_id: string;
};

type DataKeyResponse = {
  data_key: string;
  wrapped_dek: string;
  kms_key_id: string;
  kms_key_version: string;
};

function requireKmsConfig(): { url: string; token: string } {
  const url = process.env.BYOK_KMS_SERVICE_URL;
  const token = process.env.BYOK_KMS_SERVICE_TOKEN;
  if (!url || !token) {
    throw new Error(
      'BYOK_KMS_SERVICE_URL and BYOK_KMS_SERVICE_TOKEN are required; run `pnpm dev:start` or `pnpm dev:byok-kms`'
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

export async function createByokEnvelope(
  context: ByokKmsContext,
  plaintext: string
): Promise<BYOKApiKeyEnvelope> {
  const { url, token } = requireKmsConfig();
  const response = await fetch(`${url}/data-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(context),
  });
  if (!response.ok) {
    throw new Error(`BYOK KMS /data-key failed with status ${response.status}`);
  }
  const dataKey = (await response.json()) as DataKeyResponse;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(dataKey.data_key, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted_data: {
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
    wrapped_dek: dataKey.wrapped_dek,
    kms_key_id: dataKey.kms_key_id,
    kms_key_version: dataKey.kms_key_version,
    algorithm: 'aes-256-gcm',
    envelope_version: 1,
  };
}
