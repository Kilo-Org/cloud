import 'server-only';

import { after } from 'next/server';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptUsage,
  type EnkryptUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';

const notScanned: EnkryptGuardrailScanResult = { verdict: { action: 'skip' }, usageRecords: [] };

export type EnkryptInputGuardrail = {
  /**
   * Await immediately before the upstream call. Never rejects. The measured wait is the latency the
   * guardrail added to the request, and is stored on the request's final usage record.
   */
  awaitVerdict(): Promise<EnkryptGuardrailVerdict>;
};

/**
 * Starts the organization's input guardrail scan. A null scan (no organization, or the guardrail
 * is off) makes no Enkrypt call.
 *
 * Usage records are written in an `after()` callback registered now, so a request that returns
 * early still accounts for a scan Enkrypt performed.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailScan | null>,
  signal: AbortSignal
): EnkryptInputGuardrail {
  const result = scan
    .then(resolved =>
      resolved
        ? scanRequest(resolved, {
            apiKey: ENKRYPT_API_KEY,
            fetch,
            timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
            signal,
          })
        : notScanned
    )
    .catch((error: unknown): EnkryptGuardrailScanResult => {
      console.error('[enkrypt-guardrail] scan failed unexpectedly; request rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { verdict: { action: 'unavailable', reason: 'failed' }, usageRecords: [] };
    });
  let addedLatencyMs: number | null = null;
  after(async () => {
    const { usageRecords: calls } = await result;
    const usageRecords = calls.map((call, index): EnkryptUsageRecord => ({
      ...call,
      addedLatencyMs: index === calls.length - 1 ? addedLatencyMs : null,
    }));
    await Promise.all(
      usageRecords.map(usageRecord =>
        recordEnkryptUsage(usageRecord).catch((error: unknown) => {
          console.error('[enkrypt-guardrail] usage record write failed; record dropped', {
            organization_id: usageRecord.organizationId,
            kilo_user_id: usageRecord.kiloUserId,
            session_id: usageRecord.sessionId,
            api_kind: usageRecord.apiKind,
            decision: usageRecord.decision,
            credits_cost: usageRecord.creditsCost,
            charged_microdollars: enkryptCreditsToMicrodollars(usageRecord.creditsCost),
            added_latency_ms: usageRecord.addedLatencyMs,
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
