import { describe, expect, it } from 'vitest';
import {
  admitSessionSnapshotWork,
  beginSessionSnapshot,
  waitForSessionSnapshotIdle,
  invalidateSessionSnapshot,
  publishSessionSnapshot,
  readSessionSnapshot,
  sessionSnapshotsEnabled,
  readReadySessionSnapshot,
  SESSION_SNAPSHOT_KEY,
  SESSION_SNAPSHOT_TTL_MS,
  isSessionSnapshotExecutionEvent,
  type SessionSnapshotDescriptor,
} from './session-snapshot.js';
import {
  controlPlanePrepareInputSchema,
  controlPlaneRegistrationRouteSpecSchema,
} from '../shared/control-plane-protocol.js';

const identity = {
  sessionId: 'workspace_1',
  kiloSessionId: 'ses_1',
  sandboxId: 'istd-1',
  userId: 'user-1',
  orgId: 'org-1',
};
const descriptor: SessionSnapshotDescriptor = {
  ...identity,
  captureId: '11111111-1111-4111-8111-111111111111',
  lastMessageId: 'message-1',
  attemptId: 'attempt-1',
  sourceAllocationId: 'allocation-1',
  snapshotId: 'snapshot-1',
  baseImage: 'image:1',
  runtimeIdentity: 'runtime:1',
  capturedAt: 1000,
  expiresAt: 1000 + SESSION_SNAPSHOT_TTL_MS,
};
const input = {
  ...identity,
  captureId: descriptor.captureId,
  lastMessageId: descriptor.lastMessageId,
  attemptId: descriptor.attemptId,
};
function storage() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: (key: string) => values.delete(key),
  };
}

describe('session disk snapshots', () => {
  it('keeps a completed turn waiting for idle without publishing or treating it as an issued capture', () => {
    const kv = storage();
    waitForSessionSnapshotIdle(kv, input, 10_000);
    expect(readSessionSnapshot(kv)).toEqual({ state: 'waiting', input, deadlineAt: 10_000 });
    expect(publishSessionSnapshot(kv, descriptor)).toBe(false);
    expect(readReadySessionSnapshot(kv, identity, 2000)).toBeNull();
  });

  it('cancels the deferred idle obligation on new admission', () => {
    const kv = storage();
    waitForSessionSnapshotIdle(kv, input);
    admitSessionSnapshotWork(kv);
    expect(readSessionSnapshot(kv)).toBeUndefined();
  });

  it('preserves the waiting bound while starting the separately bounded native operation', () => {
    const kv = storage();
    waitForSessionSnapshotIdle(kv, input, 10_000);
    beginSessionSnapshot(kv, input, 10_000);
    expect(readSessionSnapshot(kv)).toMatchObject({
      state: 'pending',
      input,
      idleDeadlineAt: 10_000,
    });
  });
  it.each([
    { type: 'session.turn.open', properties: { sessionID: 'native' } },
    { type: 'session.status', properties: { sessionID: 'native', status: { type: 'busy' } } },
    { type: 'session.status', properties: { sessionID: 'native', status: { type: 'retry' } } },
    {
      type: 'message.part.delta',
      properties: { sessionID: 'native', messageID: 'assistant', delta: 'output', field: 'text' },
    },
    {
      type: 'message.part.updated',
      properties: {
        part: {
          sessionID: 'native',
          id: 'tool',
          messageID: 'assistant',
          type: 'tool',
          state: { status: 'running' },
        },
      },
    },
    { type: 'permission.asked', properties: { sessionID: 'native', id: 'permission' } },
  ])('recognizes native execution activity $type', event => {
    expect(isSessionSnapshotExecutionEvent(event)).toBe(true);
  });

  it.each([
    { type: 'session.turn.open', properties: {} },
    { type: 'session.turn.close', properties: { sessionID: 'native', reason: 'completed' } },
    { type: 'session.status', properties: { sessionID: 'native', status: { type: 'idle' } } },
    { type: 'session.updated', properties: { info: { id: 'native', title: 'Updated title' } } },
    {
      type: 'message.updated',
      properties: {
        info: { sessionID: 'native', id: 'assistant', role: 'assistant', time: { completed: 100 } },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        part: {
          sessionID: 'native',
          id: 'tool',
          messageID: 'assistant',
          type: 'tool',
          state: { status: 'completed' },
        },
      },
    },
    {
      type: 'message.part.delta',
      properties: { sessionID: 'native', messageID: 'assistant', delta: '' },
    },
    { type: 'wrapper_finalizing', properties: {} },
    { type: 'autocommit_completed', properties: { sessionID: 'native' } },
  ])('ignores idle and terminal metadata $type', event => {
    expect(isSessionSnapshotExecutionEvent(event)).toBe(false);
  });
  it('is default off and does not accept wildcard enrollment or environment enrollment', () => {
    expect(sessionSnapshotsEnabled({}, identity)).toBe(false);
    expect(
      sessionSnapshotsEnabled(
        { SESSION_SNAPSHOT_ORG_IDS: '*', SESSION_SNAPSHOT_USER_IDS: '*' },
        identity
      )
    ).toBe(false);
    expect(sessionSnapshotsEnabled({ SESSION_SNAPSHOT_ORG_IDS: 'org-10' }, identity)).toBe(false);
    expect(sessionSnapshotsEnabled({ SESSION_SNAPSHOT_ORG_IDS: ' org-1, org-2 ' }, identity)).toBe(
      true
    );
    expect(
      sessionSnapshotsEnabled({ SESSION_SNAPSHOT_USER_IDS: 'user-1' }, { userId: 'user-1' })
    ).toBe(true);
  });

  it('preserves a published disk through admission and repeated cold-start lookups', () => {
    const kv = storage();
    beginSessionSnapshot(kv, input);
    expect(readSessionSnapshot(kv)).toMatchObject({ state: 'pending', input });
    expect(publishSessionSnapshot(kv, descriptor)).toBe(true);
    admitSessionSnapshotWork(kv);
    admitSessionSnapshotWork(kv);
    expect(readReadySessionSnapshot(kv, identity, 2000)).toEqual(descriptor);
    expect(readReadySessionSnapshot(kv, identity, 2000)).toEqual(descriptor);
  });

  it('invalidates pending capture on admission, so a late result cannot restore older history', () => {
    const kv = storage();
    beginSessionSnapshot(kv, input);
    admitSessionSnapshotWork(kv);
    expect(publishSessionSnapshot(kv, descriptor)).toBe(false);
    expect(readReadySessionSnapshot(kv, identity, 2000)).toBeNull();
  });

  it('does not preserve an older ready snapshot when newer work has executed or capture started', () => {
    const kv = storage();
    beginSessionSnapshot(kv, input);
    publishSessionSnapshot(kv, descriptor);
    admitSessionSnapshotWork(kv);
    invalidateSessionSnapshot(kv);
    expect(readReadySessionSnapshot(kv, identity, 2000)).toBeNull();
    beginSessionSnapshot(kv, { ...input, captureId: '22222222-2222-4222-8222-222222222222' });
    expect(publishSessionSnapshot(kv, descriptor)).toBe(false);
  });

  it.each(['sessionId', 'kiloSessionId', 'sandboxId', 'userId', 'orgId'] as const)(
    'rejects a foreign %s',
    key => {
      const kv = storage();
      beginSessionSnapshot(kv, input);
      publishSessionSnapshot(kv, descriptor);
      expect(readReadySessionSnapshot(kv, { ...identity, [key]: 'foreign' }, 2000)).toBeNull();
    }
  );

  it('rejects expired, future, invalid and overlong descriptors', () => {
    for (const value of [
      null,
      { state: 'ready', descriptor: { ...descriptor, expiresAt: 'bad' } },
      { state: 'ready', descriptor: { ...descriptor, expiresAt: descriptor.expiresAt + 1 } },
    ]) {
      const kv = storage();
      kv.put(SESSION_SNAPSHOT_KEY, value);
      expect(readReadySessionSnapshot(kv, identity, 2000)).toBeNull();
    }
    for (const now of [999, descriptor.expiresAt]) {
      const kv = storage();
      beginSessionSnapshot(kv, input);
      publishSessionSnapshot(kv, descriptor);
      expect(readReadySessionSnapshot(kv, identity, now)).toBeNull();
    }
  });

  it('rejects frame-only restore provenance at both registration boundaries', () => {
    const spec = {
      sessionId: 's',
      kiloSessionId: 'k',
      directory: '/workspace/app',
      attemptId: 'a',
      sessionSnapshot: { sourceAllocationId: 'foreign' },
    };
    expect(controlPlaneRegistrationRouteSpecSchema.safeParse(spec).success).toBe(false);
    expect(
      controlPlanePrepareInputSchema.safeParse({
        spec,
        credentials: {
          userId: 'u',
          kiloSessionId: 'k',
          kiloToken: 'token',
        },
      }).success
    ).toBe(false);
  });
});
