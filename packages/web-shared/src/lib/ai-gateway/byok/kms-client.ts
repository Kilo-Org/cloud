import { z } from 'zod';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

const KMS_REQUEST_TIMEOUT_MS = 5000;
/** One attempt plus two retries for a transient failure. */
export const KMS_MAX_ATTEMPTS = 3;
const KMS_RETRY_BASE_DELAY_MS = 100;
/** Time all attempts may take together, so an outage fails closed promptly instead of
 * stalling the gateway request for one full timeout per attempt. */
const KMS_TOTAL_BUDGET_MS = 8000;

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

/**
 * Only a failure that a repeat can change is retried: a timeout, a connection failure, or a
 * 5xx answer. A 4xx rejects the request itself, so retrying it would only add latency.
 */
function isTransientKmsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // fetch raises a TypeError for network-level failures such as a reset connection.
  if (error instanceof TypeError) return true;
  // AbortSignal.timeout rejects with a TimeoutError DOMException, which does not extend Error.
  const { name } = error as { name?: unknown };
  return name === 'TimeoutError' || name === 'AbortError';
}

type KmsAttempt =
  | { kind: 'response'; response: Response }
  | { kind: 'error'; error: unknown; retryable: boolean };

async function attemptKmsRequest(
  config: ByokKmsClientConfig,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<KmsAttempt> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: { ...init.headers, authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: 'response', response };
  } catch (error) {
    return { kind: 'error', error, retryable: isTransientKmsError(error) };
  }
}

async function sendToKms(config: ByokKmsClientConfig, url: string, init: RequestInit) {
  const deadline = Date.now() + KMS_TOTAL_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    // A retry only gets the time that is left, so the whole sequence stays inside the budget.
    const timeoutMs = Math.max(1, Math.min(KMS_REQUEST_TIMEOUT_MS, deadline - Date.now()));
    const outcome = await attemptKmsRequest(config, url, init, timeoutMs);

    let error: unknown;
    let retryable: boolean;
    if (outcome.kind === 'response') {
      if (outcome.response.ok) return outcome.response.json();
      // Release the unused body so the retry reuses the connection.
      void outcome.response.body?.cancel().catch(() => {});
      error = new Error(
        `BYOK KMS ${new URL(url).pathname} failed with status ${outcome.response.status}`
      );
      retryable = outcome.response.status >= 500;
    } else {
      ({ error, retryable } = outcome);
    }

    const delayMs = KMS_RETRY_BASE_DELAY_MS * attempt + Math.random() * KMS_RETRY_BASE_DELAY_MS;
    if (!retryable || attempt >= KMS_MAX_ATTEMPTS || Date.now() + delayMs >= deadline) throw error;
    const { promise: slept, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delayMs);
    await slept;
  }
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
