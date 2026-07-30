import { describe, expect, it } from 'vitest';

import {
  applyActiveSessionTitle,
  type CachedActiveSession,
  filterActiveSessionsByOrganization,
  mergeHeartbeatForActiveSessions,
  mergeSnapshotForActiveSessions,
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

// ── Sticky DB title (D7) ─────────────────────────────────────────────

describe('sticky DB title across WS merges', () => {
  it('keeps the cached title when the row is enriched (heartbeat)', () => {
    const current = [
      makeCached({
        id: 'a',
        title: 'db-title',
        status: 'question',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        capabilities: { attachments: true },
      }),
    ];
    const result = mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [
        {
          id: 'a',
          status: 'busy',
          title: 'cli-title',
          capabilities: { attachments: false },
        },
      ],
    });
    expect(result[0]?.title).toBe('db-title');
    // Status change still applies (sticky attention keeps question).
    expect(result[0]?.status).toBe('question');
    // Capabilities upgrade/downgrade unaffected.
    expect(result[0]?.capabilities).toEqual({ attachments: false });
  });

  it('keeps the cached title when the row is enriched (snapshot)', () => {
    const current = [
      makeCached({
        id: 'a',
        title: 'db-title',
        status: 'idle',
        createdAt: '2024-01-01T00:00:00Z',
        capabilities: { attachments: false },
      }),
    ];
    const result = mergeSnapshotForActiveSessions(current, [
      {
        id: 'a',
        status: 'busy',
        title: 'cli-title',
        connectionId: 'c1',
        capabilities: { attachments: true },
      },
    ]);
    expect(result[0]?.title).toBe('db-title');
    expect(result[0]?.status).toBe('busy');
    expect(result[0]?.capabilities).toEqual({ attachments: true });
  });

  it('takes the wire title when the row is not enriched (heartbeat)', () => {
    const current = [makeCached({ id: 'a', title: 'stale', status: 'idle' })];
    const result = mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'busy', title: 'cli-title' }],
    });
    expect(result[0]?.title).toBe('cli-title');
    expect(result[0]?.status).toBe('busy');
  });

  it('takes the wire title when the row is not enriched (snapshot)', () => {
    const current = [makeCached({ id: 'a', title: 'stale', status: 'idle' })];
    const result = mergeSnapshotForActiveSessions(current, [
      { id: 'a', status: 'busy', title: 'cli-title', connectionId: 'c1' },
    ]);
    expect(result[0]?.title).toBe('cli-title');
    expect(result[0]?.status).toBe('busy');
  });
});

// ── applyActiveSessionTitle ──────────────────────────────────────────

describe('applyActiveSessionTitle', () => {
  it('renames the matching row', () => {
    const current = [
      makeCached({ id: 'a', title: 'old' }),
      makeCached({ id: 'b', title: 'other' }),
    ];
    const result = applyActiveSessionTitle(current, 'a', 'new');
    expect(result[0]?.title).toBe('new');
    expect(result[1]?.title).toBe('other');
    // Other rows untouched by identity.
    expect(result[1]).toBe(current[1]);
  });

  it('returns the same row object identity when the title already matches', () => {
    const current = [makeCached({ id: 'a', title: 'same' })];
    const result = applyActiveSessionTitle(current, 'a', 'same');
    expect(result[0]).toBe(current[0]);
  });

  it('ignores unknown session ids', () => {
    const current = [makeCached({ id: 'a', title: 'old' })];
    const result = applyActiveSessionTitle(current, 'missing', 'new');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(current[0]);
    expect(result[0]?.title).toBe('old');
  });
});

// ── Optimistic rename on an unenriched row (D8) ──────────────────────

describe('optimistic rename on an unenriched row', () => {
  it('heartbeat takes the wire title back, and the filter hides the row', () => {
    // Unenriched row (never through a tRPC fetch) — no organizationId.
    const unenriched = [makeCached({ id: 'a', title: 'cli-title' })];
    const renamed = applyActiveSessionTitle(unenriched, 'a', 'optimistic');
    expect(renamed[0]?.title).toBe('optimistic');

    // Next heartbeat carries the old CLI title → wire wins (stickiness
    // keys on isEnriched). No second stickiness mechanism.
    const afterHeartbeat = mergeHeartbeatForActiveSessions(renamed, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'cli-title' }],
    });
    expect(afterHeartbeat[0]?.title).toBe('cli-title');

    // Under D6 an unattributed row is not displayed in a filtered tray, so
    // the reverted title is invisible and AC 4 still holds.
    expect(filterActiveSessionsByOrganization(afterHeartbeat, null)).toEqual([]);
  });
});
