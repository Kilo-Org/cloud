import { describe, expect, it, vi } from 'vitest';

import type { InterruptResult } from '../../e2e/client.js';
import { cleanupOwnedSessions } from '../../e2e/smoke-cleanup.js';

function interruptResult(overrides: Partial<InterruptResult> = {}): InterruptResult {
  return {
    success: true,
    message: 'Session interruption accepted',
    processesFound: false,
    ...overrides,
  };
}

async function captureAggregateError(promise: Promise<void>): Promise<AggregateError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AggregateError) return error;
    throw error;
  }
  throw new Error('expected cleanupOwnedSessions to reject');
}

describe('cleanupOwnedSessions', () => {
  it('treats a session the scenario already deleted as cleaned and still stops its sandboxes', async () => {
    // `interruptSession` returns this after the scenario's `finally` deleted the
    // session metadata (src/router/handlers/session-management.ts:230-237).
    const interrupt = vi.fn(async () =>
      interruptResult({ success: false, message: 'Session not found' })
    );
    const stopOwnedSandboxes = vi.fn(async () => {});

    await expect(
      cleanupOwnedSessions(new Set(['workspace_deleted']), { interrupt, stopOwnedSandboxes })
    ).resolves.toBeUndefined();

    // Teardown still runs: the backstop does not assume the earlier delete
    // removed every container family.
    expect(stopOwnedSandboxes).toHaveBeenCalledWith('workspace_deleted');
  });

  it.each([
    'No accepted wrapper messages or pending queued messages',
    'No session work to interrupt',
  ])('tolerates the pre-existing settled outcome %s', async message => {
    const interrupt = vi.fn(async () => interruptResult({ success: false, message }));
    const stopOwnedSandboxes = vi.fn(async () => {});

    await expect(
      cleanupOwnedSessions(new Set(['workspace_idle']), { interrupt, stopOwnedSandboxes })
    ).resolves.toBeUndefined();
    expect(stopOwnedSandboxes).toHaveBeenCalledWith('workspace_idle');
  });

  it('still throws AggregateError for a genuine unexpected interrupt failure', async () => {
    const interrupt = vi.fn(async () =>
      interruptResult({ success: false, message: 'Interruption was not applicable' })
    );
    const stopOwnedSandboxes = vi.fn(async () => {});

    const failure = await captureAggregateError(
      cleanupOwnedSessions(new Set(['workspace_broken']), { interrupt, stopOwnedSandboxes })
    );

    expect(failure.message).toBe('Owned session cleanup failed');
    expect(failure.errors.map(error => error.message)).toEqual([
      'Failed to interrupt owned session workspace_broken; skipped teardown',
    ]);
    expect(stopOwnedSandboxes).not.toHaveBeenCalled();
  });

  it('still throws AggregateError when interrupt rejects', async () => {
    const interrupt = vi.fn(async () => {
      throw new Error('tRPC unavailable');
    });
    const stopOwnedSandboxes = vi.fn(async () => {});

    const failure = await captureAggregateError(
      cleanupOwnedSessions(new Set(['workspace_offline']), { interrupt, stopOwnedSandboxes })
    );

    expect(failure.errors.map(error => error.message)).toEqual([
      'Failed to interrupt owned session workspace_offline; skipped teardown',
    ]);
  });

  it('still reports a sandbox-stop failure for a session already deleted', async () => {
    const interrupt = vi.fn(async () =>
      interruptResult({ success: false, message: 'Session not found' })
    );
    const stopOwnedSandboxes = vi.fn(async () => {
      throw new Error('sandbox still running');
    });

    const failure = await captureAggregateError(
      cleanupOwnedSessions(new Set(['workspace_deleted']), { interrupt, stopOwnedSandboxes })
    );

    expect(failure.errors.map(error => error.message)).toEqual([
      'Failed to stop owned sandboxes for workspace_deleted',
    ]);
  });

  it('stops sandboxes for every settled session and reports every failure', async () => {
    const interrupt = vi.fn(async (sessionId: string) =>
      sessionId === 'workspace_deleted'
        ? interruptResult({ success: false, message: 'Session not found' })
        : interruptResult()
    );
    const stopOwnedSandboxes = vi.fn(async (sessionId: string) => {
      if (sessionId === 'workspace_deleted') throw new Error('sandbox still running');
    });

    const failure = await captureAggregateError(
      cleanupOwnedSessions(new Set(['workspace_live', 'workspace_deleted']), {
        interrupt,
        stopOwnedSandboxes,
      })
    );

    expect(stopOwnedSandboxes).toHaveBeenCalledWith('workspace_live');
    expect(stopOwnedSandboxes).toHaveBeenCalledWith('workspace_deleted');
    expect(failure.errors.map(error => error.message)).toEqual([
      'Failed to stop owned sandboxes for workspace_deleted',
    ]);
  });
});
