import type {
  ControlPlaneCommandFailure,
  ControlPlanePromptPayload,
} from '../../shared/control-plane-protocol.js';

const COMMAND_FAILURE_NOTE_MAX_LENGTH = 2_000;
const COMMAND_FAILURE_NOTE_HEADER =
  'Some startup commands failed during session preparation. The session started anyway.';

function commandFailureKindLabel(kind: ControlPlaneCommandFailure['kind']): string {
  switch (kind) {
    case 'build':
      return 'Environment build command';
    case 'session_setup':
      return 'Session setup command';
    case 'start':
      return 'Start command';
  }
}

export function commandFailureNote(failures: readonly ControlPlaneCommandFailure[]): string {
  const lines = [COMMAND_FAILURE_NOTE_HEADER];
  for (const failure of failures) {
    const status =
      failure.terminationReason === undefined
        ? `exited ${failure.exitCode}`
        : failure.terminationReason;
    const output = failure.outputTail?.trim();
    lines.push(
      `${commandFailureKindLabel(failure.kind)} ${failure.index} (\`${failure.commandText}\`) ${status}.${
        output === undefined || output.length === 0 ? '' : ` Last output: ${output}`
      }`
    );
  }
  return lines.join('\n').slice(0, COMMAND_FAILURE_NOTE_MAX_LENGTH);
}

/**
 * The prompt with the note in its context, or null when the existing server
 * context leaves no room for it. The existing context is kept whole.
 */
export function promptWithCommandFailureNote(
  message: ControlPlanePromptPayload,
  note: string
): ControlPlanePromptPayload | null {
  const existing = message.context?.trim();
  if (existing === undefined || existing.length === 0) {
    return { ...message, context: note.slice(0, COMMAND_FAILURE_NOTE_MAX_LENGTH) };
  }
  const room = COMMAND_FAILURE_NOTE_MAX_LENGTH - existing.length - 2;
  if (room < COMMAND_FAILURE_NOTE_HEADER.length) return null;
  return { ...message, context: `${note.slice(0, room)}\n\n${existing}` };
}
