import 'server-only';

import { after } from 'next/server';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptUsage,
  type EnkryptGuardrailCall,
  type EnkryptUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { splitEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  ENKRYPT_VERDICT_CACHE_ENABLED,
  rememberAllowedRequest,
  scanRequestWithVerdictCache,
  type EnkryptCachedScanResult,
  type EnkryptGuardrailRequest,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';

const notScanned: EnkryptCachedScanResult = {
  verdict: { action: 'skip' },
  usageRecords: [],
  allowedKey: null,
};

const verdictCacheStore = ENKRYPT_VERDICT_CACHE_ENABLED ? redisClient : null;

export type EnkryptInputGuardrail = {
  /**
   * Await immediately before the upstream call. Never rejects. Waits only for the blocking
   * detectors' scan. The measured wait is the latency the guardrail added to the request, and is
   * stored on one of the request's usage records.
   */
  awaitVerdict(): Promise<EnkryptGuardrailVerdict>;
};

type EnkryptGuardrailScans = {
  blocking: EnkryptGuardrailRequest | null;
  logOnly: EnkryptGuardrailRequest | null;
};

function splitScan(scan: EnkryptGuardrailRequest | null): EnkryptGuardrailScans {
  if (!scan) return { blocking: null, logOnly: null };
  const { blocking, logOnly } = splitEnkryptInputGuardrail(scan.config);
  return {
    blocking: blocking && { ...scan, config: blocking },
    logOnly: logOnly && { ...scan, config: logOnly },
  };
}

/**
 * The request's wait for its verdict is counted once, on the final call of its blocking scan, or
 * on the final log-only call when the blocking scan recorded no call. Without blocking detectors
 * the request waits for no scan, so that wait is about 0 ms.
 */
function usageRecordsWithAddedLatency(
  blockingCalls: EnkryptGuardrailCall[],
  logOnlyCalls: EnkryptGuardrailCall[],
  addedLatencyMs: number | null
): EnkryptUsageRecord[] {
  const calls = [...blockingCalls, ...logOnlyCalls];
  const latencyIndex = (blockingCalls.length > 0 ? blockingCalls.length : calls.length) - 1;
  return calls.map((call, index) => ({
    ...call,
    addedLatencyMs: index === latencyIndex ? addedLatencyMs : null,
  }));
}

/**
 * Starts the organization's input guardrail scans. A null scan (no organization, or the guardrail
 * is off) makes no Enkrypt call. Blocking detectors and log-only detectors are scanned in two
 * concurrent calls; only the blocking call gates the request, so log-only detectors never delay or
 * reject it.
 *
 * Usage records are written in an `after()` callback registered now, so a request that returns
 * early still accounts for a scan Enkrypt performed. An allowed request's verdict cache entry is
 * written as soon as the verdict is known, so the agent's next step can already use it, and
 * `after()` keeps the function alive until the write finishes.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailRequest | null>,
  signal: AbortSignal
): EnkryptInputGuardrail {
  const runScan = async (
    resolved: EnkryptGuardrailRequest | null
  ): Promise<EnkryptCachedScanResult> =>
    resolved
      ? scanRequestWithVerdictCache(resolved, {
          apiKey: ENKRYPT_API_KEY,
          fetch,
          timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
          signal,
          store: verdictCacheStore,
        })
      : notScanned;
  const scans = scan.then(splitScan);
  const blockingResult = scans
    .then(({ blocking }) => runScan(blocking))
    .catch((error: unknown): EnkryptCachedScanResult => {
      console.error('[enkrypt-guardrail] scan failed unexpectedly; request rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        verdict: { action: 'unavailable', reason: 'failed' },
        usageRecords: [],
        allowedKey: null,
      };
    });
  const logOnlyResult = scans
    .then(
      ({ logOnly }) => runScan(logOnly),
      // The blocking result already logs and rejects a request whose scan could not be prepared.
      () => notScanned
    )
    .catch((error: unknown): EnkryptCachedScanResult => {
      console.error('[enkrypt-guardrail] log-only scan failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      });
      return notScanned;
    });
  for (const result of [blockingResult, logOnlyResult]) {
    after(
      result.then(async ({ allowedKey }) => {
        if (allowedKey && verdictCacheStore) {
          await rememberAllowedRequest(allowedKey, verdictCacheStore);
        }
      })
    );
  }
  let addedLatencyMs: number | null = null;
  after(async () => {
    const [blocking, logOnly] = await Promise.all([blockingResult, logOnlyResult]);
    const usageRecords = usageRecordsWithAddedLatency(
      blocking.usageRecords,
      logOnly.usageRecords,
      addedLatencyMs
    );
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
      const { verdict } = await blockingResult;
      addedLatencyMs = Math.round(performance.now() - waitStartedAt);
      return verdict;
    },
  };
}
