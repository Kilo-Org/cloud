import { describe, expect, it } from 'vitest';

import {
  type CachedActiveSession,
  hasUnenrichedLiveId,
  isEnriched,
  mergeHeartbeatForActiveSessions,
  mergeSnapshotForActiveSessions,
  removeActiveSessionsForConnection,
} from '@/lib/active-sessions-live';

function makeCached(over: Partial<CachedActiveSession> = {}): CachedActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

// ── Snapshot merge ───────────────────────────────────────────────────

describe('mergeSnapshotForActiveSessions', () => {
  it('replaces the cache wholesale', () => {
    const current = [makeCached({ id: 'a' }), makeCached({ id: 'b' })];
    const snapshot = [
      { id: 'a', status: 'running', title: 'A2', connectionId: 'c1' },
      { id: 'c', status: 'running', title: 'C', connectionId: 'c1' },
    ];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result.map(r => r.id)).toEqual(['a', 'c']);
    expect(result[0]?.title).toBe('A2');
    expect(result[1]?.title).toBe('C');
  });

  it('preserves the enrichment fields and the DB title for known ids', () => {
    const enriched: CachedActiveSession[] = [
      makeCached({
        id: 'a',
        title: 'cached-title',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        gitUrl: 'git@cached',
      }),
    ];
    const unenriched: CachedActiveSession[] = [
      makeCached({
        id: 'a',
        title: 'cached-title',
        gitUrl: 'git@cached',
      }),
    ];
    const snapshot = [
      {
        id: 'a',
        status: 'running',
        title: 'ws-title',
        connectionId: 'c1',
        gitUrl: 'git@ws',
      },
    ];

    const enrichedResult = mergeSnapshotForActiveSessions(enriched, snapshot);
    expect(enrichedResult).toHaveLength(1);
    // Enriched: DB title sticky; enrichment fields sticky; other fields from wire.
    expect(enrichedResult[0]?.title).toBe('cached-title');
    expect(enrichedResult[0]?.connectionId).toBe('c1');
    expect(enrichedResult[0]?.gitUrl).toBe('git@ws');
    expect(enrichedResult[0]?.createdOnPlatform).toBe('cli');
    expect(enrichedResult[0]?.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(enrichedResult[0]?.updatedAt).toBe('2024-01-02T00:00:00Z');

    const unenrichedResult = mergeSnapshotForActiveSessions(unenriched, snapshot);
    expect(unenrichedResult).toHaveLength(1);
    // Unenriched: wire title wins so a just-spawned session shows something.
    expect(unenrichedResult[0]?.title).toBe('ws-title');
    expect(unenrichedResult[0]?.connectionId).toBe('c1');
    expect(unenrichedResult[0]?.gitUrl).toBe('git@ws');
    expect(unenrichedResult[0]?.createdOnPlatform).toBeUndefined();
    expect(unenrichedResult[0]?.createdAt).toBeUndefined();
    expect(unenrichedResult[0]?.updatedAt).toBeUndefined();
  });

  it('drops rows absent from the snapshot', () => {
    const current = [makeCached({ id: 'a' }), makeCached({ id: 'b' })];
    const snapshot = [{ id: 'a', status: 'running', title: 'A', connectionId: 'c1' }];
    expect(mergeSnapshotForActiveSessions(current, snapshot).map(r => r.id)).toEqual(['a']);
  });

  it('a WS-new id enters unenriched (no enrichment fields filled in)', () => {
    const current: CachedActiveSession[] = [];
    const snapshot = [{ id: 'new', status: 'running', title: 'New', connectionId: 'c1' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]).toMatchObject({
      id: 'new',
      title: 'New',
      connectionId: 'c1',
      createdOnPlatform: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
    expect(result[0]).toBeDefined();
    expect(isEnriched(result[0] ?? makeCached())).toBe(false);
  });

  it('a snapshot must never wipe enrichment for known ids', () => {
    const current: CachedActiveSession[] = [
      makeCached({
        id: 'a',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const snapshot = [
      { id: 'a', status: 'running', title: 'A', connectionId: 'c1' },
      { id: 'b', status: 'running', title: 'B', connectionId: 'c1' },
    ];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    const found = result.find(r => r.id === 'a');
    expect(found).toBeDefined();
    expect(found?.createdOnPlatform).toBe('cli');
    expect(found?.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(found?.updatedAt).toBe('2024-01-02T00:00:00Z');
  });
});

// ── Heartbeat merge ──────────────────────────────────────────────────

describe('mergeHeartbeatForActiveSessions', () => {
  it('replaces rows for the heartbeat connectionId and keeps other connections', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1' }),
      makeCached({ id: 'b', connectionId: 'c1' }),
      makeCached({ id: 'x', connectionId: 'c2' }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result.map(r => `${r.id}/${r.connectionId}`)).toEqual(['a/c1', 'x/c2']);
    const found = result.find(r => r.id === 'a');
    expect(found).toBeDefined();
    expect(found?.title).toBe('A2');
  });

  it('preserves enrichment for ids present in both cache and payload', () => {
    const current: CachedActiveSession[] = [
      makeCached({
        id: 'a',
        connectionId: 'c1',
        title: 'cached-title',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]).toBeDefined();
    // Enriched row: DB title sticky; enrichment fields sticky.
    expect(result[0]?.title).toBe('cached-title');
    expect(result[0]?.createdOnPlatform).toBe('cli');
    expect(result[0]?.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(result[0]?.updatedAt).toBe('2024-01-02T00:00:00Z');
  });

  it('drops a cached row whose id appears in the payload under a different connectionId (ownership transfer)', () => {
    const current = [makeCached({ id: 'a', connectionId: 'c1' })];
    const payload = {
      connectionId: 'c2',
      sessions: [{ id: 'a', status: 'running', title: 'A on c2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'a', connectionId: 'c2' });
  });

  it('does not duplicate when both connections stay live with the same session id', () => {
    const current = [makeCached({ id: 'a', connectionId: 'c1', title: 'old' })];
    const payloadFromC2 = {
      connectionId: 'c2',
      sessions: [{ id: 'a', status: 'running', title: 'A on c2' }],
    };
    const mergedAfterTransfer = mergeHeartbeatForActiveSessions(current, payloadFromC2);
    const payloadFromC1 = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A on c1 again' }],
    };
    const final = mergeHeartbeatForActiveSessions(mergedAfterTransfer, payloadFromC1);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ id: 'a', connectionId: 'c1', title: 'A on c1 again' });
  });

  it('preserves enrichment across ownership transfer', () => {
    const current: CachedActiveSession[] = [
      makeCached({
        id: 'a',
        connectionId: 'c1',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const payload = {
      connectionId: 'c2',
      sessions: [{ id: 'a', status: 'running', title: 'A on c2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'a',
      connectionId: 'c2',
      createdOnPlatform: 'cli',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    });
  });

  it('omitted session id leaves the row out (heartbeat omits prev id)', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1' }),
      makeCached({ id: 'b', connectionId: 'c1' }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result.map(r => r.id)).toEqual(['a']);
  });
});

// ── Connection removal ───────────────────────────────────────────────

describe('removeActiveSessionsForConnection', () => {
  it('drops rows for the given connectionId', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1' }),
      makeCached({ id: 'b', connectionId: 'c2' }),
    ];
    expect(removeActiveSessionsForConnection(current, 'c1').map(r => r.id)).toEqual(['b']);
  });

  it('owner transfer followed by old owner cli.disconnected removes nothing', () => {
    const current: CachedActiveSession[] = [makeCached({ id: 'a', connectionId: 'c2' })];
    expect(removeActiveSessionsForConnection(current, 'c1').map(r => r.id)).toEqual(['a']);
  });
});

// ── Enrichment helpers ───────────────────────────────────────────────

describe('isEnriched / hasUnenrichedLiveId', () => {
  it('an unenriched row is detected', () => {
    expect(isEnriched(makeCached())).toBe(false);
    expect(hasUnenrichedLiveId([makeCached()])).toBe(true);
  });
  it('a row with createdOnPlatform is enriched', () => {
    expect(isEnriched(makeCached({ createdOnPlatform: 'cli' }))).toBe(true);
  });
  it('a row with only createdAt is enriched', () => {
    expect(isEnriched(makeCached({ createdAt: '2024-01-01T00:00:00Z' }))).toBe(true);
  });
  it('a row with only updatedAt is enriched', () => {
    expect(isEnriched(makeCached({ updatedAt: '2024-01-02T00:00:00Z' }))).toBe(true);
  });
  it('hasUnenrichedLiveId is false when every row is enriched', () => {
    expect(
      hasUnenrichedLiveId([
        makeCached({ createdOnPlatform: 'cli' }),
        makeCached({ createdAt: '2024-01-01T00:00:00Z' }),
      ])
    ).toBe(false);
  });
});
