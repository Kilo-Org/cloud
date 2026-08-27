import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  buildOpaqueScopeKey,
  countGlanceableSessions,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  isEligibleGlanceableWork,
  shouldDiscardGlanceableRevision,
} from './glanceable-agents-snapshot';

const NOW = 1_750_000_000_000;

describe('countGlanceableSessions', () => {
  it('maps busy/question/permission/retry and ignores idle and unknown', () => {
    const counts = countGlanceableSessions([
      { status: 'busy' },
      { status: 'busy' },
      { status: 'question' },
      { status: 'permission' },
      { status: 'permission' },
      { status: 'retry' },
      { status: 'idle' },
      { status: 'idle' },
      { status: 'completed' },
      { status: 'failed' },
      { status: 'mystery' },
    ]);
    expect(counts).toEqual({ running: 2, needsInput: 3, reconnecting: 1 });
  });

  it('counts Cloud Agent-shaped and CLI-shaped rows together on status alone', () => {
    const cloudRow = { status: 'busy', kind: 'cloud-agent' };
    const cliRow = { status: 'retry', connectionId: 'cli-1' };
    expect(countGlanceableSessions([cloudRow, cliRow])).toEqual({
      running: 1,
      needsInput: 0,
      reconnecting: 1,
    });
  });

  it('produces zero eligible counts for idle-only sessions', () => {
    expect(countGlanceableSessions([{ status: 'idle' }, { status: 'idle' }])).toEqual({
      running: 0,
      needsInput: 0,
      reconnecting: 0,
    });
  });
});

describe('buildOpaqueScopeKey', () => {
  it('is stable for the same input and never returns the raw ids', () => {
    const a = buildOpaqueScopeKey({ userId: 'oauth/user-1', organizationId: 'org-9' });
    const b = buildOpaqueScopeKey({ userId: 'oauth/user-1', organizationId: 'org-9' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toContain('oauth/user-1');
    expect(a).not.toContain('org-9');
  });

  it('differs when the user or organization differs', () => {
    const personal = buildOpaqueScopeKey({ userId: 'u1', organizationId: null });
    const org = buildOpaqueScopeKey({ userId: 'u1', organizationId: 'org-1' });
    const otherUser = buildOpaqueScopeKey({ userId: 'u2', organizationId: 'org-1' });
    expect(new Set([personal, org, otherUser]).size).toBe(3);
  });
});

describe('buildGlanceableSnapshot', () => {
  it('increases revision and marks expiry 8 hours after updatedAt', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'oauth/user-1',
      organizationId: 'org-9',
      now: NOW,
    });
    expect(snapshot.revision).toBe(1);
    expect(snapshot.status).toBe('happy');
    expect(snapshot.running).toBe(1);
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.updatedAt)).toBe(
      GLANCEABLE_SNAPSHOT_EXPIRY_MS
    );
  });

  it('keeps revision monotonic and eligibleStartedAt while work stays eligible', () => {
    const first = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const second = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }, { status: 'question' }],
      userId: 'u1',
      organizationId: null,
      now: NOW + 5000,
      previousRevision: first.revision,
      previousEligibleStartedAt: first.eligibleStartedAt,
    });
    expect(second.revision).toBe(first.revision + 1);
    expect(second.eligibleStartedAt).toBe(first.eligibleStartedAt);
    expect(second.needsInput).toBe(1);
  });

  it('clears eligibleStartedAt when no eligible work remains', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'idle' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 3,
      previousEligibleStartedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(snapshot.status).toBe('empty');
    expect(snapshot.eligibleStartedAt).toBeNull();
    expect(snapshot.revision).toBe(4);
  });

  it('sets organizationBound only when organizationId is a string', () => {
    const personal = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const org = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: 'org-9',
      now: NOW,
    });
    expect(personal.organizationBound).toBe(false);
    expect(org.organizationBound).toBe(true);
  });

  it('honours a status override and omits accountEpoch when absent', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      status: 'waiting',
    });
    expect(snapshot.status).toBe('waiting');
    expect('accountEpoch' in snapshot).toBe(false);
  });

  it('serializes without any forbidden fixture', () => {
    const rows = [
      { status: 'busy', title: 'Secret prompt', gitUrl: 'github.com/acme/repo', id: 'ses_raw_1' },
      { status: 'question', organizationName: 'Acme Org' },
    ];
    const snapshot = buildGlanceableSnapshot({
      sessions: rows,
      userId: 'oauth/user-1',
      organizationId: 'org-9',
      now: NOW,
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('Secret prompt');
    expect(json).not.toContain('Acme Org');
    expect(json).not.toContain('github.com/acme/repo');
    expect(json).not.toContain('ses_raw_1');
    expect(json).not.toContain('oauth/user-1');
    expect(json).not.toContain('org-9');
  });
});

describe('isEligibleGlanceableWork and revision discard', () => {
  it('reports eligibility from the three counts', () => {
    const empty = buildGlanceableSnapshot({ sessions: [], userId: 'u1', organizationId: null, now: NOW });
    const busy = buildGlanceableSnapshot({ sessions: [{ status: 'busy' }], userId: 'u1', organizationId: null, now: NOW });
    expect(isEligibleGlanceableWork(empty)).toBe(false);
    expect(isEligibleGlanceableWork(busy)).toBe(true);
  });

  it('discards a lower revision and an older updatedAt at equal revision', () => {
    const current = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 4,
    });
    const lowerRevision = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW + 10_000,
      previousRevision: 3,
    });
    const olderAtEqualRevision = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW - 5000,
      previousRevision: 4,
    });
    const newerAtEqualRevision = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW + 15_000,
      previousRevision: 4,
    });
    expect(shouldDiscardGlanceableRevision(lowerRevision, current)).toBe(true);
    expect(shouldDiscardGlanceableRevision(olderAtEqualRevision, current)).toBe(true);
    expect(shouldDiscardGlanceableRevision(newerAtEqualRevision, current)).toBe(false);
  });
});
