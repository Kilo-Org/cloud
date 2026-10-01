/**
 * Reporting for an incomplete snapshot restore, shared by both restore paths:
 * the cold/backup bootstrap and the runtime-replacement attach. Every path must
 * produce the same named outcome — a wrapper log line and the preparation step —
 * instead of a bare progress line.
 */

import {
  buildRestoreIncompleteReport,
  type RestoreIncompleteReport,
} from './restore-outcome.js';

export const RESTORE_INCOMPLETE_STEP_ID = 'phase:restore_incomplete';
export const RESTORE_INCOMPLETE_LABEL = 'Session restore incomplete';

export type RestoreDiffs = {
  applied: number;
  skipped: number;
  total: number;
  skippedDiffs?: { file: string; reason: string }[];
};

export type RestoreIncompleteStepEmitter = {
  started: (label: string) => void;
  failed: (safeError: string) => void;
};

/**
 * Report an incomplete restore. `identity` names the restoring runtime in the
 * log line (kiloSessionId, and the wrapper run/generation where the caller has
 * it). Returns the report, or `undefined` when nothing was skipped.
 */
export async function reportRestoreIncomplete(options: {
  diffs: RestoreDiffs;
  identity: string;
  log: (message: string) => void;
  step?: RestoreIncompleteStepEmitter;
}): Promise<RestoreIncompleteReport | undefined> {
  const report = buildRestoreIncompleteReport(options.diffs);
  if (!report) return undefined;
  options.log(
    `bootstrap restore incomplete ${options.identity} skipped=${report.skipped} total=${report.total} reasons=${report.reasons.join(',')} paths=${report.paths.join(',')}`
  );
  // The DO's materializer drops a step event without a preceding step_started.
  options.step?.started(RESTORE_INCOMPLETE_LABEL);
  options.step?.failed(report.message);
  return report;
}
