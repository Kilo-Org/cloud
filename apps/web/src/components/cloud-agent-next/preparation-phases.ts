import type {
  PreparationAttempt,
  PreparationStepSnapshot,
  PreparationStepStatus,
} from '@/lib/cloud-agent-sdk';

export function humanizePhaseLabel(step: Pick<PreparationStepSnapshot, 'label'>): string {
  return step.label
    .replaceAll('_', ' ')
    .replace(/^./, firstCharacter => firstCharacter.toUpperCase());
}

/**
 * A phase step's display status. The setup_commands phase owns the command
 * steps, so its status aggregates theirs instead of trusting its own — a
 * failed command must surface on the phase even while the phase step itself
 * is still marked running.
 */
export function phaseStatus(
  step: PreparationStepSnapshot,
  commands: readonly PreparationStepSnapshot[]
): PreparationStepStatus {
  if (step.key === 'setup_commands' && commands.length > 0) {
    if (commands.some(command => command.status === 'failed')) return 'failed';
    if (commands.some(command => command.status === 'running')) return 'running';
    if (commands.every(command => command.status === 'completed')) return 'completed';
  }
  return step.status;
}

/** Compact "12s" / "2m 5s" duration for a finished attempt, or undefined. */
export function formatAttemptDuration(
  attempt: Pick<PreparationAttempt, 'startedAt' | 'completedAt'>
): string | undefined {
  if (attempt.completedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((attempt.completedAt - attempt.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function phaseStatusLabel(status: PreparationStepStatus): string {
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Completed';
  return 'Failed';
}
