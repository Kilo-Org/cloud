import type { InterruptResult } from './client.js';

type CleanupDependencies = {
  interrupt: (sessionId: string) => Promise<InterruptResult>;
  stopOwnedSandboxes: (sessionId: string) => Promise<void>;
};

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
        result.message !== 'No accepted wrapper messages or pending queued messages' &&
        result.message !== 'No session work to interrupt'
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
