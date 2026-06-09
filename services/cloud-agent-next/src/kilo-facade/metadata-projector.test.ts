import type { SessionUpdatedMetadataMessage } from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import type { KiloGlobalEventEnvelope } from './handlers/global-feed-upgrade/message';
import { FacadeMetadataProjector } from './metadata-projector';

const kiloSessionId = 'ses_12345678901234567890123456';

function metadataMessage(): SessionUpdatedMetadataMessage {
  return {
    type: 'system',
    event: 'session.updated',
    data: {
      source: 'v2',
      changedAt: '2026-06-08T20:00:00.000Z',
      session: {
        source: 'v2',
        sessionId: kiloSessionId,
        createdAt: '2026-06-08T19:00:00.000Z',
        updatedAt: '2026-06-08T20:00:00.000Z',
        title: 'notification only',
        createdOnPlatform: null,
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        parentSessionId: null,
        status: null,
        statusUpdatedAt: null,
      },
    },
  };
}

function sessionInfo(title: string, updated: number) {
  return {
    id: kiloSessionId,
    slug: 'session',
    projectID: 'project',
    directory: '/private/workspace',
    path: '/private/workspace',
    title,
    version: '1.0.0',
    time: { created: 100, updated },
  };
}

function snapshot(title: string, updated: number) {
  return {
    kiloSessionId,
    cloudAgentSessionId: 'agent_1',
    snapshot: { kind: 'value' as const, info: sessionInfo(title, updated), byteLength: 100 },
  };
}

function wrapperEvent(title: string, updated: number): KiloGlobalEventEnvelope {
  return {
    directory: '/private/workspace',
    payload: {
      type: 'session.updated',
      properties: { sessionID: kiloSessionId, info: sessionInfo(title, updated) },
    },
  };
}

function setup(getSnapshot: ReturnType<typeof vi.fn>) {
  const broadcast = vi.fn();
  const env = {
    SESSION_INGEST: { getCloudAgentRootSessionSnapshot: getSnapshot },
  } as unknown as Env;
  const projector = new FacadeMetadataProjector(env, broadcast, generation => generation === 1);
  projector.start(1, 'usr_1');
  return { broadcast, projector };
}

describe('FacadeMetadataProjector', () => {
  it('coalesces a newer metadata notification while a snapshot read is in flight', async () => {
    let resolveFirst: ((value: ReturnType<typeof snapshot>) => void) | undefined;
    const getSnapshot = vi
      .fn()
      .mockImplementationOnce(() => new Promise(resolve => (resolveFirst = resolve)))
      .mockResolvedValueOnce(snapshot('newest', 300));
    const { broadcast, projector } = setup(getSnapshot);

    projector.notify(metadataMessage(), 1);
    projector.notify(metadataMessage(), 1);
    resolveFirst?.(snapshot('stale', 200));

    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
    expect(broadcast.mock.calls[0]?.[0]).toMatchObject({
      payload: { properties: { info: { title: 'newest' } } },
    });
  });

  it('reruns after a wrapper update invalidates an in-flight read without regressing it', async () => {
    let resolveFirst: ((value: ReturnType<typeof snapshot>) => void) | undefined;
    const getSnapshot = vi
      .fn()
      .mockImplementationOnce(() => new Promise(resolve => (resolveFirst = resolve)))
      .mockResolvedValueOnce(snapshot('persisted older', 200));
    const { broadcast, projector } = setup(getSnapshot);

    projector.notify(metadataMessage(), 1);
    projector.recordWrapperEvent(wrapperEvent('wrapper newer', 300), kiloSessionId);
    resolveFirst?.(snapshot('stale', 200));

    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('allows one differing equal-version canonical replacement and suppresses duplicates', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(snapshot('canonical', 200));
    const { broadcast, projector } = setup(getSnapshot);

    expect(projector.recordWrapperEvent(wrapperEvent('wrapper', 200), kiloSessionId)).toBe(true);
    projector.notify(metadataMessage(), 1);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());

    expect(projector.recordWrapperEvent(wrapperEvent('equal wrapper', 200), kiloSessionId)).toBe(
      false
    );
    expect(projector.recordWrapperEvent(wrapperEvent('older wrapper', 100), kiloSessionId)).toBe(
      false
    );
    projector.notify(metadataMessage(), 1);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('bounds concurrent and pending refresh work across many sessions', () => {
    const getSnapshot = vi.fn(() => new Promise(() => {}));
    const { projector } = setup(getSnapshot);
    const sessionIds = Array.from(
      { length: 300 },
      (_, index) => `ses_${index.toString().padStart(26, '0')}`
    );

    projector.reconcile(sessionIds, 1);

    const state = projector as unknown as { refreshes: Map<string, unknown> };
    expect(getSnapshot.mock.calls.length).toBeLessThanOrEqual(8);
    expect(state.refreshes.size).toBeLessThanOrEqual(256);
  });

  it('starts a pending refresh when an active refresh completes', async () => {
    let resolveFirst: ((value: null) => void) | undefined;
    const getSnapshot = vi.fn(() => {
      if (getSnapshot.mock.calls.length === 1) {
        return new Promise<null>(resolve => (resolveFirst = resolve));
      }
      return new Promise(() => {});
    });
    const { projector } = setup(getSnapshot);
    const sessionIds = Array.from(
      { length: 9 },
      (_, index) => `ses_${index.toString().padStart(26, '0')}`
    );

    projector.reconcile(sessionIds, 1);
    expect(getSnapshot).toHaveBeenCalledTimes(8);
    resolveFirst?.(null);

    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(9));
  });

  it('bounds retained version state for long-lived global streams', () => {
    const { projector } = setup(vi.fn());

    for (let index = 0; index < 300; index += 1) {
      const sessionId = `ses_${index.toString().padStart(26, '0')}`;
      const event = wrapperEvent(`session ${index}`, index);
      if (event.payload?.properties && typeof event.payload.properties === 'object') {
        event.payload.properties.sessionID = sessionId;
        event.payload.properties.info = {
          ...sessionInfo(`session ${index}`, index),
          id: sessionId,
        };
      }
      projector.recordWrapperEvent(event, sessionId);
    }

    const state = projector as unknown as { versions: Map<string, unknown> };
    expect(state.versions.size).toBeLessThanOrEqual(256);
  });

  it('ignores a notification when the owned-root snapshot is unavailable', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(null);
    const { broadcast, projector } = setup(getSnapshot);

    projector.notify(metadataMessage(), 1);

    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    expect(broadcast).not.toHaveBeenCalled();
  });
});
