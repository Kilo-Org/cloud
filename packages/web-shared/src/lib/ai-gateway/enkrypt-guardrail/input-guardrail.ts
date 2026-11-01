import 'server-only';

import { after } from 'next/server';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptGuardrailCharge,
  type EnkryptGuardrailCharge,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';

const notScanned: EnkryptGuardrailScanResult = { verdict: { action: 'skip' }, charges: [] };

export type EnkryptInputGuardrail = {
  /**
   * Await immediately before the upstream call. Never rejects. The measured wait is the latency the
   * guardrail added to the request, and is stored on the request's final ledger row.
   */
  awaitVerdict(): Promise<EnkryptGuardrailVerdict>;
};

/**
 * Starts the organization's input guardrail scan. A null scan (no organization, or the guardrail
 * is off) makes no Enkrypt call.
 *
 * Charges are written in an `after()` callback registered now, so a request that returns early
 * still pays for a scan Enkrypt performed.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailScan | null>
): EnkryptInputGuardrail {
  const result = scan
    .then(resolved =>
      resolved
        ? scanRequest(resolved, {
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
  let addedLatencyMs: number | null = null;
  after(async () => {
    const { charges: calls } = await result;
    const charges = calls.map((call, index): EnkryptGuardrailCharge => ({
      ...call,
      addedLatencyMs: index === calls.length - 1 ? addedLatencyMs : null,
    }));
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
            added_latency_ms: charge.addedLatencyMs,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      )
    );
  });
  return {
    async awaitVerdict() {
      const waitStartedAt = performance.now();
      const { verdict } = await result;
      addedLatencyMs = Math.round(performance.now() - waitStartedAt);
      return verdict;
    },
  };
}
