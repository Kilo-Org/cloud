import 'server-only';

import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  ENKRYPT_USAGE_WRITE_PATH,
  EnkryptUsageWriteResponseSchema,
  type EnkryptUsageWriteInput,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';

/** Must stay below the endpoint's `maxDuration`; matches `recordUsageInPrimaryRegion`. */
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
  if (!INTERNAL_API_SECRET) return 'missing_internal_api_secret';
  if (!APP_URL) return 'missing_app_url';

  let response: Response;
  try {
    response = await fetch(new URL(ENKRYPT_USAGE_WRITE_PATH, APP_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(usageWrite),
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    return error instanceof Error || error instanceof DOMException ? error.name : 'fetch_failed';
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return `http_${response.status}`;
  }

  const body: unknown = await response.json().catch(() => null);
  return EnkryptUsageWriteResponseSchema.safeParse(body).success ? null : 'malformed_response';
}
