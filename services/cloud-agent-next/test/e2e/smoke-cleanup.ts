import type { InterruptResult } from './client.js';

type CleanupDependencies = {
  interrupt: (sessionId: string) => Promise<InterruptResult>;
  stopOwnedSandboxes: (sessionId: string) => Promise<void>;
};

/**
 * `success: false` outcomes that mean the session already reached its desired
 * end state, so the backstop must not treat them as a cleanup failure.
 *
 * `Session not found` is the concrete outcome of interrupting a session the
 * scenario's `finally` already deleted: `deleteSession` destroys the Durable
 * Object metadata but keeps the `cli_sessions_v2` access row, so the handler
 * passes `requireCurrentSessionAccess` and then returns this from the
 * `fetchSessionMetadata` null branch. Sandbox teardown still runs for it,
 * because the backstop cannot assume the earlier delete removed every
 * container family.
 */
const SETTLED_INTERRUPT_MESSAGES: ReadonlySet<string> = new Set([
  'No accepted wrapper messages or pending queued messages',
  'No session work to interrupt',
  'Session not found',
]);

/** Settle durable demand before killing containers that alarms could recreate. */
export async function cleanupOwnedSessions(
  sessionIds: ReadonlySet<string>,
  deps: CleanupDependencies
): Promise<void> {
  const interrupted: string[] = [];
  const errors: Error[] = [];
  for (const sessionId of sessionIds) {
    try {
      const result = await deps.interrupt(sessionId);
      if (
        !result.success &&
        (result.message === undefined || !SETTLED_INTERRUPT_MESSAGES.has(result.message))
      ) {
        throw new Error(`Interruption was not confirmed for ${sessionId}`);
      }
      interrupted.push(sessionId);
    } catch {
      errors.push(new Error(`Failed to interrupt owned session ${sessionId}; skipped teardown`));
    }
  }
  for (const sessionId of interrupted) {
    try {
      await deps.stopOwnedSandboxes(sessionId);
    } catch {
      errors.push(new Error(`Failed to stop owned sandboxes for ${sessionId}`));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Owned session cleanup failed');
}
