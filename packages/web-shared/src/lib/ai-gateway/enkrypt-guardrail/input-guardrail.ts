import 'server-only';

import { after } from 'next/server';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptGuardrailCharge,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  scanTurnDelta,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';

const notScanned: EnkryptGuardrailScanResult = { verdict: { action: 'skip' }, charges: [] };

/**
 * Starts the organization's input guardrail scan; await the verdict immediately before the
 * upstream call. A null scan (no organization, or the guardrail is off) makes no Enkrypt call.
 * The verdict never rejects.
 *
 * Charges are written in an `after()` callback registered now, so a request that returns early
 * still pays for a scan Enkrypt performed.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailScan | null>
): Promise<EnkryptGuardrailVerdict> {
  const result = scan
    .then(resolved =>
      resolved
        ? scanTurnDelta(resolved, {
            apiKey: ENKRYPT_API_KEY,
            fetch,
            timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
          })
        : notScanned
    )
    .catch((error: unknown) => {
      console.error('[enkrypt-guardrail] scan failed unexpectedly; request not scanned', {
        error: error instanceof Error ? error.message : String(error),
      });
      return notScanned;
    });
  after(async () => {
    const { charges } = await result;
    await Promise.all(
      charges.map(charge =>
        recordEnkryptGuardrailCharge(charge).catch((error: unknown) => {
          console.error('[enkrypt-guardrail] failed to record charge; charge dropped', {
            organization_id: charge.organizationId,
            kilo_user_id: charge.kiloUserId,
            session_id: charge.sessionId,
            api_kind: charge.apiKind,
            decision: charge.decision,
            credits_cost: charge.creditsCost,
            charged_microdollars: enkryptCreditsToMicrodollars(charge.creditsCost),
            error: error instanceof Error ? error.message : String(error),
          });
        })
      )
    );
  });
  return result.then(({ verdict }) => verdict);
}
