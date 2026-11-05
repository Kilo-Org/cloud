import { describe, expect, it } from 'vitest';

import {
  createLocalScenarioEnvironment,
  worktreeSnapshotsEnabled,
} from '../../e2e/capabilities-local.js';
import { assessScenarioSupport } from '../../e2e/scenario-capabilities.js';
import {
  assertNoPostPushSnapshotUpload,
  requirePushCompleted,
  requireSnapshotRestoreMessage,
} from '../../e2e/scenarios-shared-worktree-snapshots.js';
import { SHARED_SCENARIOS } from '../../e2e/scenarios-shared.js';
import type { StreamEvent } from '../../e2e/client.js';

const SNAPSHOT_SCENARIOS = [
  'worktree-snapshot-midturn-kill',
  'worktree-snapshot-autocommit-kill',
] as const;

function streamEvent(
  streamEventType: StreamEvent['streamEventType'],
  data: Record<string, unknown>
): StreamEvent {
  return { streamEventType, data } as unknown as StreamEvent;
}

describe('worktree snapshot scenarios', () => {
  it('enables the capability only when the Worker enables writes and reads', () => {
    expect(worktreeSnapshotsEnabled({})).toBe(false);
    expect(worktreeSnapshotsEnabled({ WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true' })).toBe(false);
    expect(worktreeSnapshotsEnabled({ WORKTREE_SNAPSHOT_READS_ENABLED: 'true' })).toBe(false);
    expect(
      worktreeSnapshotsEnabled({
        WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
        WORKTREE_SNAPSHOT_READS_ENABLED: 'false',
      })
    ).toBe(false);
    expect(
      worktreeSnapshotsEnabled({
        WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
        WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
      })
    ).toBe(true);
  });

  it('registers both scenarios with the local-only physical capabilities', () => {
    for (const name of SNAPSHOT_SCENARIOS) {
      const definition = SHARED_SCENARIOS[name];
      expect(definition, name).toBeDefined();
      expect(definition?.name).toBe(name);
      expect(definition?.defaultApi).toBe('unified');
      expect(definition?.defaultConversation).toBe('_');
      expect(definition?.requires).toEqual(
        expect.arrayContaining([
          'sessionSandbox',
          'sandboxFaults',
          'controlPlaneRuntime',
          'controlPlaneV2',
          'worktreeSnapshots',
        ])
      );
    }
    for (const name of SNAPSHOT_SCENARIOS) {
      expect(SHARED_SCENARIOS[name]?.requires, name).toContain('gates');
    }
  });

  it('requires zero applied changes and zero conflicts for the stale-base path', () => {
    const zero = streamEvent('preparing', {
      triggerMessageId: 'message_1',
      message: 'Restored 0 worktree changes; omitted 0; conflicts 0',
    });
    expect(
      requireSnapshotRestoreMessage([zero], 'message_1', { applied: 'zero', conflicts: 0 })
    ).toContain('conflicts 0');

    expect(() =>
      requireSnapshotRestoreMessage([zero], 'message_1', { applied: 'zero', conflicts: 1 })
    ).toThrow(/conflicts=0; expected 1/);

    const applied = streamEvent('preparing', {
      triggerMessageId: 'message_1',
      message: 'Restored 1 worktree changes; omitted 0; conflicts 0',
    });
    expect(() =>
      requireSnapshotRestoreMessage([applied], 'message_1', { applied: 'zero', conflicts: 0 })
    ).toThrow(/reapplied 1 already-pushed changes/);
  });

  it('requires a completed push and rejects a post-push snapshot upload', () => {
    const push = streamEvent('autocommit_completed', {
      userMessageId: 'message_1',
      success: true,
      message: 'Changes committed; push command completed',
    });
    expect(requirePushCompleted([push], 'message_1')).toMatchObject({ success: true });

    const failedPush = streamEvent('autocommit_completed', {
      userMessageId: 'message_1',
      success: true,
      message: 'Changes committed (push failed: denied)',
    });
    expect(() => requirePushCompleted([failedPush], 'message_1')).toThrow(
      /did not prove a completed push/
    );

    expect(() => assertNoPostPushSnapshotUpload({ prePushCount: 1, postPushCount: 2 })).toThrow(
      /raced/
    );
    expect(() =>
      assertNoPostPushSnapshotUpload({ prePushCount: 2, postPushCount: 2 })
    ).not.toThrow();
  });

  it('is unsupported until the Worker flags provide the capability', () => {
    const defaultLocal = createLocalScenarioEnvironment();
    const enabledLocal = createLocalScenarioEnvironment({ worktreeSnapshotsEnabled: true });
    const definition = SHARED_SCENARIOS['worktree-snapshot-midturn-kill'];
    if (definition === undefined) throw new Error('scenario is not registered');

    expect(assessScenarioSupport(definition, defaultLocal).missing).toContain('worktreeSnapshots');
    expect(assessScenarioSupport(definition, defaultLocal).supported).toBe(false);
    expect(assessScenarioSupport(definition, enabledLocal).supported).toBe(true);
  });
});
