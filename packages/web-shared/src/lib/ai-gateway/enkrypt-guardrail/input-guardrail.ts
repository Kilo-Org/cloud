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
  guardrailSettings,
  type EnkryptGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import {
  ENKRYPT_VERDICT_CACHE_ENABLED,
  mostSevereVerdict,
  rememberRequestVerdict,
  scanRequestWithVerdictCache,
  type EnkryptCachedScanResult,
  type EnkryptGuardrailRequest,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';
import { createEnkryptCallLimiter } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/call-limiter';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type { EnkryptRequestLog } from '@kilocode/web-shared/lib/r2/api-request-log';

const verdictCacheStore = ENKRYPT_VERDICT_CACHE_ENABLED ? redisClient : null;

export type EnkryptInputGuardrail = {
  /**
   * Await immediately before the upstream call. Never rejects. Waits only for the blocking
   * detectors' scan and, for a block, its cache write. The measured wait is the latency the
   * guardrail added to the request, and is stored on one of the request's usage records.
   */
  awaitVerdict(): Promise<EnkryptGuardrailVerdict>;
  /**
   * The settings and steps of the guardrail for this request, or null without a guardrail. Waits
   * for every scan and verdict cache write, so call it after the response, like `after()` work.
   */
  report(): Promise<EnkryptGuardrailReport | null>;
  requestLogs(captureResponse?: boolean): Promise<EnkryptRequestLog[]>;
};

type VerdictCacheWrite = EnkryptGuardrailReport['scans'][number]['verdict_cache_write'];

/** A request's verdict acts on its most severe part: a block, then an unavailable scan. */
export function combinedVerdict(results: EnkryptCachedScanResult[]): EnkryptGuardrailVerdict {
  return mostSevereVerdict(results.map(result => result.verdict));
}

/** For tool definitions: `failed` if any write failed, else `written` if any was written. */
function combinedWrite(writes: VerdictCacheWrite[]): VerdictCacheWrite {
  if (writes.includes('failed')) return 'failed';
  return writes.includes('written') ? 'written' : 'skipped';
}

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
export function usageRecordsWithAddedLatency(
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
 * is off) makes no Enkrypt call. Blocking detectors and log-only detectors are scanned
 * concurrently, each over every tool definition, the system prompt, and the conversation
 * separately; only the blocking calls gate the request, so log-only detectors never delay or
 * reject it. All of them share at most `ENKRYPT_MAX_CONCURRENT_CALLS` Enkrypt calls in flight, and
 * blocking calls get a free slot first, so log-only calls only delay the verdict by holding slots
 * they already have.
 *
 * Usage records are written in an `after()` callback registered now, so a request that returns
 * early still accounts for a scan Enkrypt performed. A request's verdict cache entry is
 * written as soon as the verdict is known, so the agent's next step can already use it, and
 * `after()` keeps the function alive until the write finishes.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailRequest | null>,
  signal: AbortSignal
): EnkryptInputGuardrail {
  const requestLogs: Promise<EnkryptRequestLog>[] = [];
  const captureResponse = Promise.withResolvers<boolean>();
  const limiter = createEnkryptCallLimiter();
  const runScan = async (
    resolved: EnkryptGuardrailRequest | null
  ): Promise<EnkryptCachedScanResult[]> =>
    resolved
      ? scanRequestWithVerdictCache(resolved, {
          apiKey: ENKRYPT_API_KEY,
          fetch,
          timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
          limiter,
          signal,
          store: verdictCacheStore,
          requestLog: {
            guardrail: 'input',
            capture: entry => requestLogs.push(entry),
            captureResponse: captureResponse.promise,
          },
        })
      : [];
  const scans = scan.then(splitScan);
  const blockingResults = scans
    .then(({ blocking }) => runScan(blocking))
    .catch((error: unknown): EnkryptCachedScanResult[] => {
      console.error('[enkrypt-guardrail] scan failed unexpectedly; request rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [
        {
          verdict: { action: 'unavailable', reason: 'failed' },
          usageRecords: [],
          report: null,
          cacheEntries: [],
        },
      ];
    });
  const logOnlyResults = scans
    .then(
      ({ logOnly }) => runScan(logOnly),
      // The blocking result already logs and rejects a request whose scan could not be prepared.
      () => []
    )
    .catch((error: unknown): EnkryptCachedScanResult[] => {
      console.error('[enkrypt-guardrail] log-only scan failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
  const cacheWrites = [blockingResults, logOnlyResults].map(results =>
    results.then(each =>
      Promise.all(
        each.map(async ({ cacheEntries }): Promise<VerdictCacheWrite> => {
          const store = verdictCacheStore;
          if (!store) return 'skipped';
          return combinedWrite(
            await Promise.all(cacheEntries.map(entry => rememberRequestVerdict(entry, store)))
          );
        })
      )
    )
  );
  for (const cacheWrite of cacheWrites) after(cacheWrite);
  let addedLatencyMs: number | null = null;
  after(async () => {
    const [blocking, logOnly] = await Promise.all([blockingResults, logOnlyResults]);
    const usageRecords = usageRecordsWithAddedLatency(
      blocking.flatMap(result => result.usageRecords),
      logOnly.flatMap(result => result.usageRecords),
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
    async requestLogs(shouldCaptureResponse = true) {
      captureResponse.resolve(shouldCaptureResponse);
      await Promise.all([blockingResults, logOnlyResults]);
      return Promise.all(requestLogs);
    },
    async awaitVerdict() {
      const waitStartedAt = performance.now();
      const verdict = combinedVerdict(await blockingResults);
      if (verdict.action === 'block') await cacheWrites[0];
      addedLatencyMs = Math.round(performance.now() - waitStartedAt);
      return verdict;
    },
    async report() {
      const [request, blocking, logOnly, [blockingWrites, logOnlyWrites]] = await Promise.all([
        scan.catch(() => null),
        blockingResults,
        logOnlyResults,
        Promise.all(cacheWrites),
      ]);
      const verdict = combinedVerdict(blocking);
      const scanReports = (results: EnkryptCachedScanResult[], writes: VerdictCacheWrite[] = []) =>
        results.flatMap(({ report }, index) =>
          report ? [{ ...report, verdict_cache_write: writes[index] ?? 'skipped' }] : []
        );
      const scans = [
        ...scanReports(blocking, blockingWrites),
        ...scanReports(logOnly, logOnlyWrites),
      ];
      if (!request && verdict.action === 'skip') return null;
      return {
        settings: request && guardrailSettings(request.config),
        verdict: verdict.action,
        unavailable_reason: verdict.action === 'unavailable' ? verdict.reason : null,
        added_latency_ms: addedLatencyMs,
        scans,
      };
    },
  };
}
