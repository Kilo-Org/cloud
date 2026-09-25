/**
 * Reporting for an incomplete snapshot restore, shared by both restore paths:
 * the cold/backup bootstrap and the runtime-replacement attach. Every path must
 * produce the same named outcome — a wrapper log line, the agent-facing rules
 * file, and the preparation step — instead of a bare progress line.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildRestoreIncompleteReport,
  buildRestoreIncompleteRules,
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

/** The rules file the agent reads before it continues (RulesMigrator discovers it). */
export function restoreIncompleteRulesPath(sessionHome: string): string {
  return path.join(sessionHome, '.kilocode/rules/restore-incomplete.md');
}

/**
 * Report an incomplete restore, or clear a stale note when every diff applied.
 * `identity` names the restoring runtime in the log line (kiloSessionId, and the
 * wrapper run/generation where the caller has it). Returns the report, or
 * `undefined` when nothing was skipped.
 */
export async function reportRestoreIncomplete(options: {
  diffs: RestoreDiffs;
  sessionHome: string;
  identity: string;
  log: (message: string) => void;
  step?: RestoreIncompleteStepEmitter;
}): Promise<RestoreIncompleteReport | undefined> {
  const rulesPath = restoreIncompleteRulesPath(options.sessionHome);
  const report = buildRestoreIncompleteReport(options.diffs);
  if (!report) {
    // A complete restore must not leave a stale note behind.
    await fs.rm(rulesPath, { force: true });
    return undefined;
  }
  options.log(
    `bootstrap restore incomplete ${options.identity} skipped=${report.skipped} total=${report.total} reasons=${report.reasons.join(',')} paths=${report.paths.join(',')}`
  );
  // The DO's materializer drops a step event without a preceding step_started.
  options.step?.started(RESTORE_INCOMPLETE_LABEL);
  options.step?.failed(report.message);
  await fs.mkdir(path.dirname(rulesPath), { recursive: true });
  await fs.writeFile(rulesPath, buildRestoreIncompleteRules(report));
  return report;
}
