import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

// ── Expected-condition telemetry ───────────────────────────────────────────

/**
 * Interval-aggregated counter for expected, traffic-scaled admission
 * conditions (legacy clients, malformed shapes). Emits one structured log
 * line per 60 s window carrying the count observed in that window instead of
 * one event per request, so rollout traffic cannot flood telemetry. The
 * window start is carried on each line so a burst after a traffic pause is
 * attributed to the window it was counted in.
 */
const AGGREGATE_INTERVAL_MS = 60_000;
const admissionCounters = new Map<string, number>();
let admissionCountersWindowStart = 0;

function flushAdmissionCounters(now: number): void {
  if (admissionCounters.size === 0) return;
  for (const [metric, count] of admissionCounters) {
    warnExceptInTest(
      JSON.stringify({
        event: 'native_admission_aggregate',
        metric,
        count,
        intervalMs: AGGREGATE_INTERVAL_MS,
        // Window the counts were accumulated in, not the flush time.
        windowStart: new Date(admissionCountersWindowStart).toISOString(),
        at: new Date(now).toISOString(),
      })
    );
  }
  admissionCounters.clear();
}

/**
 * Roll the window forward when it has elapsed. Called on every admission
 * check, so the window closes on any later traffic rather than only when
 * another counted condition arrives — the last window of a sparse traffic
 * pattern is not silently dropped.
 */
export function rollAdmissionWindowIfNeeded(now: number): void {
  if (now - admissionCountersWindowStart >= AGGREGATE_INTERVAL_MS) {
    flushAdmissionCounters(now);
    admissionCountersWindowStart = now;
  }
}

/**
 * Count an expected, traffic-scaled admission outcome. Refusals are the normal
 * shape of hostile traffic, so they aggregate per window instead of emitting
 * one event each. Unexpected provider faults keep their per-event message.
 */
export function countAdmissionCondition(metric: string): void {
  const now = Date.now();
  rollAdmissionWindowIfNeeded(now);
  admissionCounters.set(metric, (admissionCounters.get(metric) ?? 0) + 1);
}

/**
 * The aggregate window is closed only by later native-auth traffic on the same
 * instance, so a rare refusal counted by an instance that serves nothing
 * further would otherwise leave no trace. One report per class per interval
 * keeps such a refusal visible while bounding the volume a repeated one can
 * produce.
 */
const RARE_REFUSAL_REPORT_INTERVAL_MS = 60_000;
const lastRareRefusalReportAt = new Map<string, number>();

/** Emits at most one per-event report per class per interval per instance. */
export function reportAdmissionRefusalOnce(metric: string): void {
  const now = Date.now();
  if (now - (lastRareRefusalReportAt.get(metric) ?? 0) < RARE_REFUSAL_REPORT_INTERVAL_MS) return;
  lastRareRefusalReportAt.set(metric, now);
  captureMessage(metric);
}

/** Exported for tests: flush any pending counters and reset the interval. */
export function resetAdmissionCountersForTests(): void {
  admissionCounters.clear();
  admissionCountersWindowStart = 0;
  lastRareRefusalReportAt.clear();
}
