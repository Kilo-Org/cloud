import { createCipheriv, randomBytes } from 'node:crypto';

import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';

import { localByokKmsServiceConfig } from '../../local/infra-env';

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves the KMS endpoint a seed talks to. `.env.local` (synced by
 * `pnpm dev:start`) wins; a blank value falls back to this worktree's local
 * `byok-kms` service, so a seed works without `dev:start` having rewritten the
 * file. The dev token is only ever paired with a loopback URL, so a remote URL
 * set without its own token fails instead of receiving a dev credential.
 */
export function resolveByokKmsConfig(
  env: Record<string, string | undefined>,
  local: { url: string; token: string }
): { url: string; token: string } {
  const url = env.BYOK_KMS_SERVICE_URL?.trim() || local.url;
  const token = env.BYOK_KMS_SERVICE_TOKEN?.trim() || (isLoopbackUrl(url) ? local.token : '');
  if (!token) {
    throw new Error(
      `BYOK_KMS_SERVICE_TOKEN is required when BYOK_KMS_SERVICE_URL is ${url}, which is not a local address`
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

export async function createByokEnvelope(
  context: ByokKmsContext,
  plaintext: string
): Promise<BYOKApiKeyEnvelope> {
  const { url, token } = resolveByokKmsConfig(process.env, localByokKmsServiceConfig());
  const response = await fetch(`${url}/data-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(context),
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BYOK KMS service is unreachable at ${url} (${reason}); run \`pnpm dev:start\` or \`pnpm dev:byok-kms\``
    );
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
