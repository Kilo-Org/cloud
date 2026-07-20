import type { PreparationAttempt, PreparationStepSnapshot } from '@/lib/cloud-agent-sdk';
import { formatAttemptDuration, humanizePhaseLabel } from './preparation-phases';

export { isNoOpCompletedPreparationAttempt } from '@/lib/cloud-agent-sdk';

/** The single line the chat row shows for a preparation attempt. */
export type PreparationRowSummary =
  | { kind: 'starting' }
  | { kind: 'phase'; text: string }
  | { kind: 'command'; command: string; commandIndex?: number; commandCount?: number }
  | { kind: 'completed'; duration?: string }
  | { kind: 'failed'; error?: string };

export function summarizePreparationAttempt(attempt: PreparationAttempt): PreparationRowSummary {
  if (attempt.status === 'completed') {
    return { kind: 'completed', duration: formatAttemptDuration(attempt) };
  }
  if (attempt.status === 'failed') {
    return { kind: 'failed', error: attempt.safeError ?? lastFailedStepError(attempt.steps) };
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
