import 'server-only';

import { types } from 'node:util';
import { captureException } from '@sentry/nextjs';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { parseInternalServiceUrl } from '@kilocode/web-shared/lib/internal-service-url';
import {
  REGION_HANDOFF_TOKEN_WAIT_MS,
  STS_WEB_USAGE_RECORD_REGION_HANDOFF,
  webInternalSenderCredential,
  type WebInternalSenderCredential,
} from '@kilocode/web-shared/lib/web-internal-sts';
import {
  ENKRYPT_USAGE_WRITE_PATH,
  EnkryptUsageWriteResponseSchema,
  type EnkryptUsageWriteInput,
} from '@kilocode/usage-contracts';

/**
 * The whole handoff, the credential included. Must stay below the endpoint's `maxDuration`;
 * matches `recordUsageInPrimaryRegion`.
 */
const HANDOFF_TIMEOUT_MS = 90_000;

/**
 * Posts to `APP_URL`, the Frankfurt-only `kilocode-app`, like `recordUsageInPrimaryRegion`.
 * Returns false when the write may not have happened there, so the caller writes it locally.
 */
export async function recordEnkryptUsageInPrimaryRegion(
  usageWrite: EnkryptUsageWriteInput
): Promise<boolean> {
  const reason = await handOff(usageWrite);
  if (reason === null) return true;
  console.error(
    '[enkrypt-guardrail] failed to record usage in the primary region; writing locally',
    {
      usage_id: usageWrite.id,
      reason,
    }
  );
  captureException(new Error('Enkrypt usage handoff to primary region failed'), {
    tags: { source: 'recordEnkryptUsageInPrimaryRegion', reason },
    extra: { usageId: usageWrite.id },
  });
  return false;
}

async function handOff(usageWrite: EnkryptUsageWriteInput): Promise<string | null> {
  // `WEB_INTERNAL_SENDER_AUTH`: the internal secret unless set to `sts`, then a
  // `web:usage.region-handoff.record` STS token. Without one the caller writes locally. A cold
  // mint waits at most `REGION_HANDOFF_TOKEN_WAIT_MS`, taken out of `HANDOFF_TIMEOUT_MS`.
  const startedAt = Date.now();
  let credential: WebInternalSenderCredential;
  try {
    credential = await webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, {
      legacySecret: readInternalApiSecret,
      tokenWait: REGION_HANDOFF_TOKEN_WAIT_MS,
    });
  } catch {
    return 'internal_api_secret_unavailable';
  }
  if (credential.kind === 'unavailable') {
    return credential.reason === 'secret_missing'
      ? 'missing_internal_api_secret'
      : `credential_${credential.reason}`;
  }
  if (!APP_URL) return 'missing_app_url';
  if (!parseInternalServiceUrl(APP_URL)) return 'unsupported_app_url';

  let response: Response;
  try {
    response = await fetch(new URL(ENKRYPT_USAGE_WRITE_PATH, APP_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [credential.header]: credential.value,
      },
      body: JSON.stringify(usageWrite),
      signal: AbortSignal.timeout(Math.max(1, HANDOFF_TIMEOUT_MS - (Date.now() - startedAt))),
      cache: 'no-store',
    });
  } catch (error) {
    return error instanceof Error || error instanceof DOMException ? error.name : 'fetch_failed';
  }
  if (!response.ok) {
    await response.body?.cancel().catch((error: unknown) => {
      console.warn('[enkrypt-guardrail] failed to cancel the primary region error response body', {
        usage_id: usageWrite.id,
        error_name: errorName(error),
      });
    });
    return `http_${response.status}`;
  }

  const body: unknown = await response.json().catch((error: unknown) => {
    console.warn('[enkrypt-guardrail] failed to parse the primary region response body', {
      usage_id: usageWrite.id,
      error_name: errorName(error),
    });
    return null;
  });
  const parsed = EnkryptUsageWriteResponseSchema.safeParse(body);
  if (!parsed.success) return 'malformed_response';
  const { usageId } = parsed.data;
  return usageId === undefined || usageId === usageWrite.id ? null : 'usage_id_mismatch';
}

function errorName(error: unknown): string {
  return types.isNativeError(error) ? error.name : 'unknown';
}
