import { type PrRef, setMergePartialSuccess } from './merge-result-banner-store';
import { gateMergeResult, type MergePullRequestResult } from './merge-result-gate';

type MergeSuccessEffects = {
  /** Whether the sheet should celebrate (haptic + refetch + dismiss). */
  celebrate: boolean;
};

/**
 * Pure helper that wires the post-merge success side effects.
 *
 * - `clean` and `partial` both return `{ celebrate: true }`.
 * - `partial` also writes the persistent banner to `merge-result-banner-store`.
 * - `incomplete` returns `{ celebrate: false }` and writes nothing.
 *
 * In production the mutation hook throws on `incomplete` before the sheet
 * reaches this helper, so the `incomplete` branch is defensive.
 */
export function applyMergeSuccessEffects(
  result: MergePullRequestResult,
  ref: PrRef
): MergeSuccessEffects {
  const gate = gateMergeResult(result);
  if (gate.kind === 'incomplete') {
    return { celebrate: false };
  }
  if (gate.kind === 'partial') {
    setMergePartialSuccess(ref, { reason: gate.reason });
  }
  return { celebrate: true };
}
