import { describe, expect, it } from 'vitest';

import {
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

// ── organizationId sticky through WS merges ──────────────────────────

describe('organizationId preservation across merges', () => {
  it('preserves a known uuid organizationId across a heartbeat', () => {
    const current = [
      makeCached({
        id: 'a',
        organizationId: 'org-1',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'busy', title: 'wire' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.organizationId).toBe('org-1');
  });

  it('preserves a known uuid organizationId across a snapshot', () => {
    const current = [
      makeCached({
        id: 'a',
        organizationId: 'org-1',
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const snapshot = [{ id: 'a', status: 'busy', title: 'wire', connectionId: 'c1' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]?.organizationId).toBe('org-1');
  });

  it('leaves organizationId undefined for an id that first appears in the payload', () => {
    const heartbeat = mergeHeartbeatForActiveSessions([], {
      connectionId: 'c1',
      sessions: [{ id: 'new', status: 'running', title: 'New' }],
    });
    expect(heartbeat[0]?.organizationId).toBeUndefined();
    expect('organizationId' in (heartbeat[0] ?? {})).toBe(true);

    const snapshot = mergeSnapshotForActiveSessions(
      [],
      [{ id: 'new', status: 'running', title: 'New', connectionId: 'c1' }]
    );
    expect(snapshot[0]?.organizationId).toBeUndefined();
  });

  it('preserves organizationId: null as null (not collapsed to undefined)', () => {
    const current = [
      makeCached({
        id: 'a',
        organizationId: null,
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    const heartbeat = mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'wire' }],
    });
    expect(heartbeat[0]?.organizationId).toBeNull();
    // Explicit backstop: null must not become undefined (that would hide
    // every personal row from the personal tray under the D6 filter).
    expect(heartbeat[0]?.organizationId).not.toBeUndefined();

    const snapshot = mergeSnapshotForActiveSessions(current, [
      { id: 'a', status: 'running', title: 'wire', connectionId: 'c1' },
    ]);
    expect(snapshot[0]?.organizationId).toBeNull();
    expect(snapshot[0]?.organizationId).not.toBeUndefined();
  });

  it('still preserves the three enrichment fields and capabilities as before', () => {
    const current = [
      makeCached({
        id: 'a',
        organizationId: null,
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        capabilities: { attachments: true },
      }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'busy', title: 'wire' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.createdOnPlatform).toBe('cli');
    expect(result[0]?.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(result[0]?.updatedAt).toBe('2024-01-02T00:00:00Z');
    expect(result[0]?.capabilities).toEqual({ attachments: true });
    expect(result[0]?.organizationId).toBeNull();
  });
});

// ── filterActiveSessionsByOrganization ───────────────────────────────

describe('filterActiveSessionsByOrganization', () => {
  type Row = { id: string; organizationId?: string | null };
  const personal: Row = { id: 'p', organizationId: null };
  const org1: Row = { id: 'o1', organizationId: 'org-1' };
  const org2: Row = { id: 'o2', organizationId: 'org-2' };
  // Field omitted — never server-attributed (WS-inserted).
  const unattributed: Row = { id: 'u' };
  const all: Row[] = [personal, org1, org2, unattributed];

  it('undefined context returns a copy of everything', () => {
    const result = filterActiveSessionsByOrganization(all, undefined);
    expect(result.map(r => r.id)).toEqual(['p', 'o1', 'o2', 'u']);
    expect(result).not.toBe(all);
  });

  it('null context keeps personal, drops org rows and unattributed rows', () => {
    const result = filterActiveSessionsByOrganization(all, null);
    expect(result.map(r => r.id)).toEqual(['p']);
  });

  it('uuid context keeps only that org, drops personal and unattributed', () => {
    const result = filterActiveSessionsByOrganization(all, 'org-1');
    expect(result.map(r => r.id)).toEqual(['o1']);
  });

  it('drops an absent-field row in both null and uuid contexts', () => {
    const onlyUnattributed: Row[] = [unattributed];
    expect(filterActiveSessionsByOrganization(onlyUnattributed, null)).toEqual([]);
    expect(filterActiveSessionsByOrganization(onlyUnattributed, 'org-1')).toEqual([]);
  });
});

// ── D6 two-heartbeat re-admission guard ──────────────────────────────

describe('D6 heartbeat re-admission guard', () => {
  it('does not re-admit an out-of-context heartbeat row into a filtered tray', () => {
    // Cache starts with one server-attributed personal row.
    const cache = [
      makeCached({
        id: 'personal',
        organizationId: null,
        createdOnPlatform: 'cli',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];

    // Heartbeat also carries an org session (no org id on the wire → enters
    // unattributed). Under a naive "missing ⇒ personal" rule this would
    // appear in the personal tray forever.
    const heartbeat = {
      connectionId: 'c1',
      sessions: [
        { id: 'personal', status: 'running', title: 'Personal' },
        { id: 'org-session', status: 'running', title: 'Org' },
      ],
    };

    const afterFirst = mergeHeartbeatForActiveSessions(cache, heartbeat);
    const filteredFirst = filterActiveSessionsByOrganization(afterFirst, null);
    expect(filteredFirst.map(r => r.id)).toEqual(['personal']);

    // Second heartbeat: still only the personal row survives the filter.
    const afterSecond = mergeHeartbeatForActiveSessions(afterFirst, heartbeat);
    const filteredSecond = filterActiveSessionsByOrganization(afterSecond, null);
    expect(filteredSecond.map(r => r.id)).toEqual(['personal']);

    // The unattributed org row is present in the raw cache (enrichment will
    // attribute it later) but never shown in the filtered tray.
    expect(afterSecond.find(r => r.id === 'org-session')?.organizationId).toBeUndefined();
  });
});
