import { NON_ENROLLABLE_BENCHMARK_MODEL_REASON } from '@kilocode/auto-routing-contracts';

/**
 * A structured record for every enrollment path that refuses a non-enrollable model.
 * The paths that also write a row status report the same reason through
 * `benchmarkPairUnavailability`; this covers the ones that only skip. It lives in its
 * own module (contracts only) so `db.ts` can log without importing `platform-models.ts`,
 * which imports `db.ts`.
 */
export function logBlockedBenchmarkEnrollment(
  entry: { model: string; variant: string | null },
  source: string
): void {
  console.warn(
    JSON.stringify({
      event: 'benchmark_model_enrollment_blocked',
      model: entry.model,
      variant: entry.variant,
      source,
      reason: NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
    })
  );
}
