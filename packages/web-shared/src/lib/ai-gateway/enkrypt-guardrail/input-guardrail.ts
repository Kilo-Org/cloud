import 'server-only';

import { after } from 'next/server';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptUsage,
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
  mostSevereVerdict,
  rememberRequestVerdict,
  scanRequestWithVerdictCache,
  type EnkryptCachedScanResult,
  type EnkryptGuardrailRequest,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type { EnkryptRequestLog } from '@kilocode/web-shared/lib/r2/api-request-log';

export type EnkryptInputGuardrail = {
  /**
   * Await immediately before the upstream call. Never rejects. Waits only for the blocking
   * detectors' scan and, for a block, its cache write. The measured wait is the latency the
   * guardrail added to the request, and is stored in the report. A guardrail that only logs adds
   * none, so the report stores its log-only scan time instead. That is not what a blocking scan
   * would add, since one stops at its first detection.
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

/** For a result's cache entries: `failed` if any write failed, else `written` if any was written. */
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

/** Never rejects: a failed write is logged, with `logFields` first, and the record dropped. */
export async function recordEnkryptUsageRecords(
  usageRecords: EnkryptUsageRecord[],
  logFields: Record<string, unknown> = {}
): Promise<void> {
  await Promise.all(
    usageRecords.map(usageRecord =>
      recordEnkryptUsage(usageRecord).catch((error: unknown) => {
        console.error('[enkrypt-guardrail] usage record write failed; record dropped', {
          ...logFields,
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
}

/**
 * Starts the organization's input guardrail scans. A null scan (no organization, or the guardrail
 * is off) makes no Enkrypt call. Blocking detectors and log-only detectors are scanned separately,
 * each over every tool definition, the system prompt, and the conversation; only the blocking calls
 * gate the request, so log-only detectors never reject it.
 *
 * The input guardrail's Enkrypt calls run strictly one at a time, so its scans never hold more than
 * one call of the shared Enkrypt service: the blocking scan's first, then the log-only scan's, which
 * starts only once the blocking scan finished. This covers the input guardrail only: the output
 * guardrail scans separately, and can overlap with log-only input calls still running. The request waits only for the blocking scan, so
 * running it first means log-only work never delays the verdict. All calls share one deadline of
 * `ENKRYPT_GUARDRAIL_TIMEOUT_MS`, started once the scan is prepared, so the log-only scan gets what
 * the blocking scan leaves of it; a call with no time left is not made and fails, like any call that
 * runs out of time. The log-only scan also runs when the blocking scan blocked the request, so the
 * report still shows what its detectors would have flagged.
 *
 * Usage records are written in an `after()` callback registered now, so a request that returns
 * early still accounts for a scan Enkrypt performed. A request's verdict cache entries, each for
 * one segment or slice of one, are written as soon as the verdict is known, so the agent's next
 * step can already use them, and `after()` keeps the function alive until the writes finish.
 */
export function startEnkryptInputGuardrail(
  scan: Promise<EnkryptGuardrailRequest | null>,
  signal: AbortSignal
): EnkryptInputGuardrail {
  const requestLogs: Promise<EnkryptRequestLog>[] = [];
  const captureResponse = Promise.withResolvers<boolean>();
  const runScan = async (
    resolved: EnkryptGuardrailRequest | null,
    deadline: AbortSignal | null
  ): Promise<EnkryptCachedScanResult[]> =>
    resolved && deadline
      ? scanRequestWithVerdictCache(resolved, {
          apiKey: ENKRYPT_API_KEY,
          fetch,
          timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
          deadline,
          signal,
          store: redisClient,
          requestLog: {
            guardrail: 'input',
            capture: entry => requestLogs.push(entry),
            captureResponse: captureResponse.promise,
          },
        })
      : [];
  const scans = scan.then(resolved => ({
    ...splitScan(resolved),
    deadline: resolved && AbortSignal.timeout(ENKRYPT_GUARDRAIL_TIMEOUT_MS),
  }));
  const blockingResults = scans
    .then(({ blocking, deadline }) => runScan(blocking, deadline))
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
      async ({ logOnly, deadline }) => {
        await blockingResults;
        return runScan(logOnly, deadline);
      },
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
        each.map(async ({ cacheEntries }) =>
          combinedWrite(
            await Promise.all(cacheEntries.map(entry => rememberRequestVerdict(entry, redisClient)))
          )
        )
      )
    )
  );
  for (const cacheWrite of cacheWrites) after(cacheWrite);
  let waitStartedAt: number | null = null;
  let addedLatencyMs: number | null = null;
  const logOnlyFinishedAt = logOnlyResults.then(() => performance.now());
  /**
   * The wait the guardrail added. A guardrail that only logs adds none, so this is its log-only
   * scan time: from when the request awaited the verdict until the log-only scan finished. Settles
   * once every scan has.
   */
  const latencyMs = async (): Promise<number | null> => {
    const [{ blocking, logOnly }, finishedAt] = await Promise.all([
      scans.catch(() => ({ blocking: null, logOnly: null })),
      logOnlyFinishedAt,
      blockingResults,
    ]);
    return !blocking && logOnly && waitStartedAt !== null
      ? Math.max(0, Math.round(finishedAt - waitStartedAt))
      : addedLatencyMs;
  };
  after(async () => {
    const results = (await Promise.all([blockingResults, logOnlyResults])).flat();
    await recordEnkryptUsageRecords(results.flatMap(result => result.usageRecords));
  });
  return {
    async requestLogs(shouldCaptureResponse = true) {
      captureResponse.resolve(shouldCaptureResponse);
      await Promise.all([blockingResults, logOnlyResults]);
      return Promise.all(requestLogs);
    },
    async awaitVerdict() {
      const startedAt = performance.now();
      waitStartedAt = startedAt;
      const verdict = mostSevereVerdict((await blockingResults).map(result => result.verdict));
      if (verdict.action === 'block') await cacheWrites[0];
      addedLatencyMs = Math.round(performance.now() - startedAt);
      return verdict;
    },
    async report() {
      const [request, blocking, logOnly, [blockingWrites, logOnlyWrites], latency] =
        await Promise.all([
          scan.catch(() => null),
          blockingResults,
          logOnlyResults,
          Promise.all(cacheWrites),
          latencyMs(),
        ]);
      const verdict = mostSevereVerdict(blocking.map(result => result.verdict));
      const scanReports = (results: EnkryptCachedScanResult[], writes: VerdictCacheWrite[]) =>
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
        added_latency_ms: latency,
        scans,
      };
    },
  };
}
