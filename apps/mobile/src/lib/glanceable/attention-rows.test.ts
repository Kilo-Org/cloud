import { beforeEach, describe, expect, it } from 'vitest';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  __resetSessionAttentionForTests,
  ackSessionAttention,
  reconcileSessionAttention,
} from '@/lib/session-attention';

import { isAnsweredAttentionRow, resolveAnsweredRaises } from './attention-rows';

beforeEach(() => {
  __resetSessionAttentionForTests();
});

describe('resolveAnsweredRaises', () => {
  it('leaves an unanswered raise counted as its waiting status', () => {
    const rows = [
      { id: 's1', status: 'permission' },
      { id: 's2', status: 'busy' },
      { id: 's3', status: 'idle' },
    ];

    expect(resolveAnsweredRaises(rows)).toEqual(rows);
  });

  it('resolves an answered raise to idle so the surfaces stop reporting Needs input', () => {
    ackSessionAttention('s1');

    expect(resolveAnsweredRaises([{ id: 's1', status: 'permission' }])).toEqual([
      { id: 's1', status: 'idle' },
    ]);
  });

  it('keeps a different session waiting when only one raise was answered', () => {
    ackSessionAttention('s1');

    expect(
      resolveAnsweredRaises([
        { id: 's1', status: 'question' },
        { id: 's2', status: 'permission' },
      ])
    ).toEqual([
      { id: 's1', status: 'idle' },
      { id: 's2', status: 'permission' },
    ]);
  });

  it('does not reclassify a non-attention row the ack store still holds', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'permission', 'R1');

    expect(resolveAnsweredRaises([{ id: 's1', status: 'busy' }])).toEqual([
      { id: 's1', status: 'busy' },
    ]);
  });

  it('counts a re-raise again once reconcile replaces the answered raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'permission', 'R1');
    reconcileSessionAttention('s1', 'permission', 'R2');

    expect(
      resolveAnsweredRaises([{ id: 's1', status: 'permission', statusUpdatedAt: 'R2' }])
    ).toEqual([{ id: 's1', status: 'permission', statusUpdatedAt: 'R2' }]);
  });

  it('matches the raise identity the reconciler stored', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'permission', 'R1');

    expect(isAnsweredAttentionRow({ id: 's1', status: 'permission', statusUpdatedAt: 'R1' })).toBe(
      true
    );
  });

  it('resolves a raise the tray reconciler pinned to the raw status while the row carries a timestamp', () => {
    ackSessionAttention('s1');
    // The tray rows reconcile with no timestamp (`(tabs)/_layout.tsx`,
    // `remote-session-row.tsx`), so the ack pins to the raw status while the
    // same tray row carries the server `statusUpdatedAt`.
    reconcileSessionAttention('s1', 'permission', null);

    expect(
      resolveAnsweredRaises([
        { id: 's1', status: 'permission', statusUpdatedAt: '2026-09-18T21:00:00.000Z' },
      ])
    ).toEqual([{ id: 's1', status: 'idle', statusUpdatedAt: '2026-09-18T21:00:00.000Z' }]);
  });

  it('drops an answered raise from the derived counts while a waiting sibling stays', () => {
    ackSessionAttention('s1');
    const rows = [
      { id: 's1', status: 'permission' },
      { id: 's2', status: 'permission' },
      { id: 's3', status: 'busy' },
    ];

    const snapshot = buildGlanceableSnapshot({
      sessions: resolveAnsweredRaises(rows),
      userId: 'user-1',
      organizationId: 'org-1',
      now: 1_000_000,
    });

    expect(snapshot.needsInput).toBe(1);
    expect(snapshot.idle).toBe(1);
    expect(snapshot.running).toBe(1);
  });

  it('republishes the status notification as idle when the tray pinned the ack to the raw status', () => {
    // The e3 sequence: answer the raise headlessly, the mounted tray resolves
    // the pending ack against the raw status, then the glanceable republish
    // reads the same tray row carrying its server `statusUpdatedAt`. Both shade
    // surfaces must agree, so the Active-agents status must not still say
    // "Needs input" beside the needs-input notification's "Request approved".
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'permission', null);
    const rows = [{ id: 's1', status: 'permission', statusUpdatedAt: '2026-09-18T21:00:00.000Z' }];

    const snapshot = buildGlanceableSnapshot({
      sessions: resolveAnsweredRaises(rows),
      userId: 'user-1',
      organizationId: 'org-1',
      now: 1_000_000,
    });

    expect(snapshot.needsInput).toBe(0);
    expect(snapshot.idle).toBe(1);
    expect(snapshot.running).toBe(0);
  });
});
