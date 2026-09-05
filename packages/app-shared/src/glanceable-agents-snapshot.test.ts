import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  buildOpaqueScopeKey,
  countGlanceableSessions,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  isEligibleGlanceableWork,
  oldestNeedsInputSince,
  shouldDiscardGlanceableRevision,
} from './glanceable-agents-snapshot';

const NOW = 1_750_000_000_000;

describe('countGlanceableSessions', () => {
  it('maps busy to running, question/permission/retry to needs-input, idle to idle', () => {
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
    expect(counts).toEqual({ running: 2, needsInput: 4, idle: 2 });
  });

  it('counts Cloud Agent-shaped and CLI-shaped rows together on status alone', () => {
    const cloudRow = { status: 'busy', kind: 'cloud-agent' };
    const cliRow = { status: 'retry', connectionId: 'cli-1' };
    expect(countGlanceableSessions([cloudRow, cliRow])).toEqual({
      running: 1,
      needsInput: 1,
      idle: 0,
    });
  });

  it('counts idle-only sessions as idle', () => {
    expect(countGlanceableSessions([{ status: 'idle' }, { status: 'idle' }])).toEqual({
      running: 0,
      needsInput: 0,
      idle: 2,
    });
  });

  it('ignores a completed or unknown status entirely', () => {
    expect(
      countGlanceableSessions([{ status: 'completed' }, { status: 'failed' }, { status: 'nope' }])
    ).toEqual({ running: 0, needsInput: 0, idle: 0 });
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

  it('keeps revision monotonic and reports the oldest wait from the rows', () => {
    const waitedLonger = new Date(NOW - 600_000).toISOString();
    const first = buildGlanceableSnapshot({
      sessions: [{ status: 'question', statusUpdatedAt: waitedLonger }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const second = buildGlanceableSnapshot({
      sessions: [
        { status: 'busy' },
        { status: 'question', statusUpdatedAt: waitedLonger },
        { status: 'permission', statusUpdatedAt: new Date(NOW - 1000).toISOString() },
      ],
      userId: 'u1',
      organizationId: null,
      now: NOW + 5000,
      previousRevision: first.revision,
    });
    expect(second.revision).toBe(first.revision + 1);
    expect(second.needsInput).toBe(2);
    // Read from the rows every build, so a later revision still reports the
    // oldest wait rather than a value latched at the first eligible emit.
    expect(second.needsInputSince).toBe(waitedLonger);
  });

  it('clears needsInputSince when no session is connected', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'completed' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 3,
    });
    expect(snapshot.status).toBe('empty');
    expect(snapshot.needsInputSince).toBeNull();
    expect(snapshot.revision).toBe(4);
  });

  it('reports no wait while work runs but nothing needs input', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [
        { status: 'busy', statusUpdatedAt: new Date(NOW - 900_000).toISOString() },
        { status: 'idle', statusUpdatedAt: new Date(NOW - 900_000).toISOString() },
      ],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    expect(snapshot.status).toBe('happy');
    expect(snapshot.needsInputSince).toBeNull();
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
    const empty = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const busy = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    expect(isEligibleGlanceableWork(empty)).toBe(false);
    expect(isEligibleGlanceableWork(busy)).toBe(true);
  });

  it('resolves the surfaces when every session went idle without being opened', () => {
    // e23: a question session answered elsewhere lands in `idle`. The badge
    // and the Agents list clear on that transition, so the Live Activity must
    // resolve too: an idle-only fleet keeps no surface alive, and the island
    // must not go on showing the count the user just resolved.
    const question = buildGlanceableSnapshot({
      sessions: [{ status: 'question' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const idled = buildGlanceableSnapshot({
      sessions: [{ status: 'idle' }],
      userId: 'u1',
      organizationId: null,
      now: NOW + 60_000,
      previousRevision: question.revision,
    });
    expect(isEligibleGlanceableWork(question)).toBe(true);
    expect(isEligibleGlanceableWork(idled)).toBe(false);
    expect(idled.status).toBe('empty');
    // The idle count survives on the snapshot: ranked rows still read it
    // while other work keeps a surface alive.
    expect(idled.idle).toBe(1);
  });

  it('keeps a surface alive while any session works even if others idle', () => {
    const mixed = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }, { status: 'idle' }, { status: 'idle' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    expect(isEligibleGlanceableWork(mixed)).toBe(true);
    expect(mixed.status).toBe('happy');
    expect(mixed.idle).toBe(2);
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

describe('oldestNeedsInputSince', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  it('returns the earliest wait among the needs-input rows', () => {
    expect(
      oldestNeedsInputSince([
        { status: 'question', statusUpdatedAt: at(60_000) },
        { status: 'retry', statusUpdatedAt: at(600_000) },
        { status: 'permission', statusUpdatedAt: at(120_000) },
      ])
    ).toBe(at(600_000));
  });

  it('ignores a row that does not need input, however old', () => {
    expect(
      oldestNeedsInputSince([
        { status: 'busy', statusUpdatedAt: at(9_000_000) },
        { status: 'idle', statusUpdatedAt: at(8_000_000) },
        { status: 'question', statusUpdatedAt: at(1000) },
      ])
    ).toBe(at(1000));
  });

  it('skips a missing or unparseable timestamp instead of reporting now', () => {
    expect(oldestNeedsInputSince([{ status: 'question' }])).toBeNull();
    expect(
      oldestNeedsInputSince([{ status: 'question', statusUpdatedAt: 'not a date' }])
    ).toBeNull();
    expect(
      oldestNeedsInputSince([
        { status: 'question', statusUpdatedAt: 'not a date' },
        { status: 'question', statusUpdatedAt: at(300_000) },
      ])
    ).toBe(at(300_000));
  });

  it('returns null when nothing needs input', () => {
    expect(oldestNeedsInputSince([{ status: 'busy', statusUpdatedAt: at(1000) }])).toBeNull();
    expect(oldestNeedsInputSince([])).toBeNull();
  });
});
