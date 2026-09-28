import type { PreparationAttempt, PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { formatAttemptDuration, humanizePhaseLabel } from './preparation-phases';

export { isNoOpCompletedPreparationAttempt } from '@kilocode/cloud-agent-sdk';

/** The single line the chat row shows for a preparation attempt. */
export type PreparationRowSummary =
  | { kind: 'starting' }
  | { kind: 'phase'; text: string }
  | { kind: 'command'; command: string; commandIndex?: number; commandCount?: number }
  | { kind: 'completed'; duration?: string }
  | { kind: 'failed'; error?: string }
  | { kind: 'incomplete'; text: string };

export function summarizePreparationAttempt(attempt: PreparationAttempt): PreparationRowSummary {
  // A terminal failure outranks the incomplete-restore step: a skipped diff
  // keeps the attempt alive while the wrapper continues, so the same attempt
  // can be `failed` AND carry `restore_incomplete`. The step's own text stays
  // readable in the details drawer, but the row must not mask the failure.
  if (attempt.status === 'failed') {
    return { kind: 'failed', error: attempt.safeError ?? lastFailedStepError(attempt.steps) };
  }
  // A completed (or still-running) attempt can carry the named incomplete-restore
  // step; surface it before the completion collapse so the fact stays visible.
  const incomplete = attempt.steps.find(step => step.key === 'restore_incomplete');
  if (incomplete) {
    return { kind: 'incomplete', text: incomplete.safeError ?? incomplete.label };
  }
  if (attempt.status === 'completed') {
    return { kind: 'completed', duration: formatAttemptDuration(attempt) };
  }

  const command = findRunningSetupCommand(attempt);
  if (command) {
    return {
      kind: 'command',
      command: command.command ?? command.label,
      commandIndex: command.commandIndex,
      commandCount: command.commandCount,
    };
  }

  const phase = attempt.steps.find(step => step.kind === 'phase' && step.status === 'running');
  if (phase) {
    return { kind: 'phase', text: phaseDisplayText(phase) };
  }

  return { kind: 'starting' };
}

/**
 * The one line the details drawer shows for an attempt. It is built from the
 * same {@link summarizePreparationAttempt} the chat row uses, so the row and
 * the panel it opens cannot describe the same attempt differently — an
 * incomplete restore reads as "Session restore incomplete…" in both.
 */
export function preparationSummaryLine(attempt: PreparationAttempt): string {
  const title = preparationSummaryTitle(summarizePreparationAttempt(attempt));
  const duration = formatAttemptDuration(attempt);
  return duration ? `${title} · ${duration}` : title;
}

function preparationSummaryTitle(summary: PreparationRowSummary): string {
  if (summary.kind === 'incomplete') return summary.text;
  if (summary.kind === 'failed') return 'Preparation failed';
  if (summary.kind === 'completed') return 'Environment prepared';
  return 'Preparing environment';
}

/**
 * The one line shown for a phase step. The progress message ("Cloning
 * repository…") and the phase label ("Cloning") say the same thing — show
 * only the message, which is friendlier and can carry live progress, and
 * fall back to the humanized label for steps that never reported one.
 */
export function phaseDisplayText(step: PreparationStepSnapshot): string {
  return step.latestDetail ?? humanizePhaseLabel(step);
}

/** The setup command currently streaming output, if any. */
export function findRunningSetupCommand(
  attempt: PreparationAttempt
): PreparationStepSnapshot | undefined {
  return attempt.steps.find(step => step.kind === 'setup_command' && step.status === 'running');
}

/** Last `maxLines` lines of an output tail, for the live ticker. */
export function extractTickerLines(outputTail: string | undefined, maxLines = 3): string[] {
  if (!outputTail) return [];
  const lines = outputTail.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-maxLines);
}

function lastFailedStepError(steps: readonly PreparationStepSnapshot[]): string | undefined {
  return steps.findLast(step => step.status === 'failed' && step.safeError !== undefined)
    ?.safeError;
}
