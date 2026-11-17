import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';

/** The non-fatal command phases a user needs to see even after preparation succeeds. */
export type FailedCommandKind = 'session_setup' | 'start';

export type FailedCommandRow = {
  attemptId: string;
  stepId: string;
  kind: FailedCommandKind;
  commandIndex: number;
  commandCount?: number;
  command?: string;
  exitCode?: number;
  timedOut: boolean;
};

const COMMAND_KIND_BY_PHASE_KEY: Record<string, FailedCommandKind> = {
  session_setup_commands: 'session_setup',
  start_commands: 'start',
};

/**
 * Failed session setup and start command rows. Build command failures stay in
 * the preparation drawer because they fail the attempt; these commands are
 * non-fatal, so a completed attempt would otherwise say only "Environment
 * prepared" and hide them.
 */
export function failedCommandRows(attempt: PreparationAttempt): FailedCommandRow[] {
  const phaseKinds = new Map<string, FailedCommandKind>();
  for (const step of attempt.steps) {
    const kind = step.kind === 'phase' ? COMMAND_KIND_BY_PHASE_KEY[step.key] : undefined;
    if (kind) phaseKinds.set(step.id, kind);
  }

  const rows: FailedCommandRow[] = [];
  for (const step of attempt.steps) {
    if (step.kind !== 'setup_command' || step.status !== 'failed') continue;
    const kind = step.parentStepId === undefined ? undefined : phaseKinds.get(step.parentStepId);
    if (!kind) continue;
    rows.push({
      attemptId: attempt.id,
      stepId: step.id,
      kind,
      commandIndex: step.commandIndex ?? 0,
      ...(step.commandCount === undefined ? {} : { commandCount: step.commandCount }),
      ...(step.command === undefined ? {} : { command: step.command }),
      ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
      timedOut: isTimedOut(step.safeError),
    });
  }
  return rows.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.commandIndex - right.commandIndex
  );
}

export function describeFailedCommand(row: FailedCommandRow): string {
  const label = row.kind === 'start' ? 'Start command' : 'Session setup command';
  const position =
    row.commandCount === undefined
      ? `${row.commandIndex + 1}`
      : `${row.commandIndex + 1} of ${row.commandCount}`;
  const command = row.command === undefined ? '' : ` (\`${row.command}\`)`;
  const outcome = row.timedOut
    ? 'timed out'
    : row.exitCode === undefined
      ? 'failed'
      : `exited ${row.exitCode}`;
  return `${label} ${position}${command} ${outcome}`;
}

function isTimedOut(safeError: string | undefined): boolean {
  return safeError !== undefined && /timed out|timeout/i.test(safeError);
}
