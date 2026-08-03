import { describe, expect, it } from 'vitest';

import {
  buildActiveSessionsTrayInput,
  type CachedActiveSession,
  CLOUD_AGENT_CONNECTION_ID,
  mergeHeartbeatForActiveSessions,
  mergeSnapshotForActiveSessions,
  removeActiveSessionsForConnection,
} from '@/lib/active-sessions-live';
import { buildActiveSessionsInput } from '@/lib/agent-session-input';

function makeCached(over: Partial<CachedActiveSession> = {}): CachedActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

function makeCloud(over: Partial<CachedActiveSession> = {}): CachedActiveSession {
  return makeCached({
    id: 'cloud-1',
    connectionId: CLOUD_AGENT_CONNECTION_ID,
    createdOnPlatform: 'cloud-agent',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    lastActivityAt: '2024-01-02T00:30:00Z',
    ...over,
  });
}

describe('cloud sentinel merge (wipe guard)', () => {
  it('snapshot without cloud ids keeps sentinel rows', () => {
    const cloud = makeCloud();
    const current = [makeCached({ id: 'cli-a' }), cloud];
    const snapshot = [{ id: 'cli-a', status: 'running', title: 'CLI', connectionId: 'c1' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result.map(r => r.id)).toEqual(['cli-a', 'cloud-1']);
    expect(result.find(r => r.id === 'cloud-1')?.connectionId).toBe(CLOUD_AGENT_CONNECTION_ID);
  });

  it('snapshot that includes a cloud id adopts the snapshot connectionId', () => {
    // Router dedupe mirror: a CLI that has adopted the session id wins.
    // Enriched rows keep the sticky DB title.
    const cloud = makeCloud({ id: 'shared', title: 'cloud-title' });
    const current = [cloud];
    const snapshot = [{ id: 'shared', status: 'busy', title: 'Adopted', connectionId: 'c-real' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'shared',
      connectionId: 'c-real',
      title: 'cloud-title',
    });
  });

  it('preserves lastActivityAt across snapshot merges', () => {
    const current = [
      makeCached({
        id: 'a',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        lastActivityAt: '2024-01-02T00:15:00Z',
      }),
    ];
    const snapshot = [{ id: 'a', status: 'running', title: 'A', connectionId: 'c1' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]?.lastActivityAt).toBe('2024-01-02T00:15:00Z');
  });

  it('keeps sentinel cloud rows across heartbeats', () => {
    const cloud = makeCloud();
    const current = [makeCached({ id: 'a', connectionId: 'c1' }), cloud];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result.map(r => r.id).toSorted()).toEqual(['a', 'cloud-1']);
    expect(result.find(r => r.id === 'cloud-1')?.connectionId).toBe(CLOUD_AGENT_CONNECTION_ID);
  });

  it('a heartbeat reporting the same id under a real connection adopts it', () => {
    // Enriched cloud row: sticky title; connectionId comes from the heartbeat.
    const cloud = makeCloud({ id: 'shared', title: 'cloud-title' });
    const current = [cloud];
    const payload = {
      connectionId: 'c-real',
      sessions: [{ id: 'shared', status: 'busy', title: 'CLI owns it' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'shared',
      connectionId: 'c-real',
      title: 'cloud-title',
    });
  });

  it('preserves lastActivityAt across heartbeat merges', () => {
    const current = [
      makeCached({
        id: 'a',
        connectionId: 'c1',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        lastActivityAt: '2024-01-02T00:15:00Z',
      }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.lastActivityAt).toBe('2024-01-02T00:15:00Z');
  });

  it('disconnect of a real connection keeps sentinel cloud rows', () => {
    const cloud = makeCloud();
    const current = [makeCached({ id: 'a', connectionId: 'c1' }), cloud];
    const result = removeActiveSessionsForConnection(current, 'c1');
    expect(result.map(r => r.id)).toEqual(['cloud-1']);
    expect(result[0]?.connectionId).toBe(CLOUD_AGENT_CONNECTION_ID);
  });
});

describe('buildActiveSessionsTrayInput', () => {
  it('wraps buildActiveSessionsInput and opts into cloud merge', () => {
    expect(buildActiveSessionsTrayInput(null)).toEqual({
      ...buildActiveSessionsInput(null),
      includeCloudAgentSessions: true,
    });
    expect(buildActiveSessionsTrayInput('org-1')).toEqual({
      ...buildActiveSessionsInput('org-1'),
      includeCloudAgentSessions: true,
    });
    expect(buildActiveSessionsTrayInput(undefined)).toEqual({
      ...buildActiveSessionsInput(undefined),
      includeCloudAgentSessions: true,
    });
  });

  it('collapses absent org context to personal (parity with buildActiveSessionsInput)', () => {
    expect(buildActiveSessionsTrayInput(undefined).organizationId).toBe(null);
    expect(buildActiveSessionsTrayInput(null).organizationId).toBe(null);
  });
});
