import type {
  PreparationAttempt,
  PreparationStepSnapshot,
  PreparationStepStatus,
} from '@kilocode/cloud-agent-sdk';

export function humanizePhaseLabel(step: Pick<PreparationStepSnapshot, 'label'>): string {
  return step.label
    .replaceAll('_', ' ')
    .replace(/^./, firstCharacter => firstCharacter.toUpperCase());
}

export function commandsForPhase(
  phase: PreparationStepSnapshot,
  steps: readonly PreparationStepSnapshot[]
): PreparationStepSnapshot[] {
  if (phase.kind !== 'phase') return [];
  // Legacy preparations did not set `parentStepId` on their command steps. Keep
  // showing those under the first setup phase so they are not dropped.
  const firstSetupPhase = steps.find(
    step => step.kind === 'phase' && step.key === 'setup_commands'
  );
  return steps.filter(
    step =>
      step.kind === 'setup_command' &&
      (step.parentStepId === phase.id ||
        (step.parentStepId === undefined && firstSetupPhase?.id === phase.id))
  );
}

/**
 * A phase step's display status. A phase that owns command steps aggregates
 * theirs instead of trusting its own — a failed command must surface on the
 * phase even while the phase step itself is still marked running. Build
 * commands fail preparation; session setup and start commands are non-fatal and
 * keep the phase completed, with their failures reported as separate rows.
 */
export function phaseStatus(
  step: PreparationStepSnapshot,
  commands: readonly PreparationStepSnapshot[]
): PreparationStepStatus {
  if (commands.length > 0) {
    if (
      step.key !== 'session_setup_commands' &&
      step.key !== 'start_commands' &&
      commands.some(command => command.status === 'failed')
    ) {
      return 'failed';
    }
    if (commands.some(command => command.status === 'running')) return 'running';
    if (commands.every(command => command.status !== 'running')) return 'completed';
  }
  return step.status;
}

export function formatAttemptDuration(
  attempt: Pick<PreparationAttempt, 'startedAt' | 'completedAt'>,
  now?: number
): string | undefined {
  const end = attempt.completedAt ?? now;
  if (end === undefined) return undefined;
  const seconds = Math.max(0, Math.round((end - attempt.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function phaseStatusLabel(status: PreparationStepStatus): string {
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Completed';
  return 'Failed';
}
