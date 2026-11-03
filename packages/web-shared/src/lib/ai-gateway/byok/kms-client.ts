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
/** A retry is worth issuing only with a slice of budget this large left: a shorter one can
 * only abort and would replace the specific error of the attempt before it with a timeout. */
const KMS_MIN_ATTEMPT_BUDGET_MS = 500;

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

/** A timeout or a connection failure: the only transport failures a repeat can change. */
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

/** The wait a `Retry-After` header asks for, in ms; a date is measured from `now`. */
function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return null;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

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
  let failure: unknown;
  for (let attempt = 1; ; attempt++) {
    // A retry only gets the time that is left, so the whole sequence stays inside the budget,
    // and a slice too short to answer is not spent: the earlier error is the specific one.
    const remainingMs = deadline - Date.now();
    if (attempt > 1 && remainingMs < KMS_MIN_ATTEMPT_BUDGET_MS) throw failure;
    const timeoutMs = Math.min(KMS_REQUEST_TIMEOUT_MS, remainingMs);
    const outcome = await attemptKmsRequest(config, url, init, timeoutMs);

    let error: unknown;
    let retryable: boolean;
    let retryAfter: number | null = null;
    if (outcome.kind === 'response') {
      if (outcome.response.ok) return outcome.response.json();
      const { status } = outcome.response;
      // Release the unused body so the retry reuses the connection.
      void outcome.response.body?.cancel().catch(() => {});
      error = new Error(`BYOK KMS ${new URL(url).pathname} failed with status ${status}`);
      // 408 and 429 are the 4xx answers a lagging or rate-limited KMS returns; every other 4xx
      // rejects the request itself, so a repeat would only add latency.
      retryable = status === 408 || status === 429 || status >= 500;
      if (retryable) retryAfter = retryAfterMs(outcome.response, Date.now());
    } else {
      ({ error, retryable } = outcome);
    }

    // A rate-limited service can ask for a specific wait; sleeping shorter gains nothing, and a
    // hint that reaches past the budget fails the call now instead of after another attempt.
    const delayMs = Math.max(
      KMS_RETRY_BASE_DELAY_MS * attempt + Math.random() * KMS_RETRY_BASE_DELAY_MS,
      retryAfter ?? 0
    );
    if (!retryable || attempt >= KMS_MAX_ATTEMPTS || Date.now() + delayMs >= deadline) throw error;
    failure = error;
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
