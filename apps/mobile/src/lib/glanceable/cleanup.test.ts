import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  planOrgFenceAction,
  republishLastSnapshotStale,
  writePrivacySnapshotAndEnd,
  writeSignedOutSnapshotAndEnd,
} from './cleanup';
import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
  getLastGlanceableSnapshot,
} from './persist';
import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';

type SinkCall =
  | { type: 'publish'; snapshot: GlanceableAgentsSnapshot }
  | { type: 'startOrUpdate'; snapshot: GlanceableAgentsSnapshot }
  | { type: 'endImmediate' };

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: GlanceableSink = {
    publish(snapshot) {
      _setLastGlanceableSnapshotForTests(snapshot);
      calls.push({ type: 'publish', snapshot });
    },
    startOrUpdate(snapshot) {
      calls.push({ type: 'startOrUpdate', snapshot });
    },
    endImmediate() {
      calls.push({ type: 'endImmediate' });
    },
  };
  return { sink, calls };
}

function lastSnapshot(calls: SinkCall[]): GlanceableAgentsSnapshot {
  const found = [...calls].toReversed().find(call => call.type === 'publish');
  if (found === undefined) {
    throw new Error('no publish call');
  }
  return found.snapshot;
}

afterEach(() => {
  _resetGlanceablePersistForTests();
  vi.useRealTimers();
});

describe('cleanup', () => {
  it('writes the signed-out snapshot before ending, and skips the terminal wait', () => {
    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    try {
      writeSignedOutSnapshotAndEnd();
      expect(calls.map(call => call.type)).toEqual(['publish', 'endImmediate']);
      const snapshot = lastSnapshot(calls);
      expect(snapshot.status).toBe('signed_out');
      expect(snapshot.running + snapshot.needsInput + snapshot.reconnecting).toBe(0);
    } finally {
      unregisterGlanceableSink(sink);
    }
  });

  it('blanks to privacy on org switch', () => {
    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    try {
      writePrivacySnapshotAndEnd();
      const snapshot = lastSnapshot(calls);
      expect(snapshot.status).toBe('privacy');
      expect(snapshot.running + snapshot.needsInput + snapshot.reconnecting).toBe(0);
    } finally {
      unregisterGlanceableSink(sink);
    }
  });

  it('blanks to privacy only after a successful list misses the selection', () => {
    expect(
      planOrgFenceAction({
        organizationId: 'missing-org',
        orgs: [{ organizationId: 'kept-org' }],
        isLoading: false,
        isError: false,
      })
    ).toBe('privacy');
    expect(
      planOrgFenceAction({
        organizationId: 'missing-org',
        orgs: [{ organizationId: 'kept-org' }],
        isLoading: true,
        isError: false,
      })
    ).toBe('none');
    expect(
      planOrgFenceAction({
        organizationId: 'kept-org',
        orgs: [{ organizationId: 'kept-org' }],
        isLoading: false,
        isError: false,
      })
    ).toBe('none');
    expect(
      planOrgFenceAction({ organizationId: null, orgs: [], isLoading: false, isError: false })
    ).toBe('none');
    // An offline or not-yet-fetched list (orgs undefined) is not a lost org.
    expect(
      planOrgFenceAction({
        organizationId: 'kept-org',
        orgs: undefined,
        isLoading: false,
        isError: false,
      })
    ).toBe('none');
  });

  it('keeps the original deadline through repeated org list failures', () => {
    vi.useFakeTimers();
    expect(
      planOrgFenceAction({
        organizationId: 'kept-org',
        orgs: undefined,
        isLoading: false,
        isError: true,
      })
    ).toBe('stale');

    const seeded: GlanceableAgentsSnapshot = {
      schemaVersion: 1,
      revision: 3,
      updatedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-27T08:00:00.000Z',
      scopeKey: 'deadbeef',
      accountEpoch: 7,
      organizationBound: true,
      status: 'happy',
      running: 2,
      needsInput: 1,
      reconnecting: 1,
      eligibleStartedAt: '2026-08-26T23:00:00.000Z',
    };
    _setLastGlanceableSnapshotForTests(seeded);

    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    try {
      for (const [index, now] of [
        '2026-08-27T01:00:00.000Z',
        '2026-08-27T07:59:59.999Z',
      ].entries()) {
        vi.setSystemTime(new Date(now));
        republishLastSnapshotStale();
        expect(lastSnapshot(calls)).toEqual({ ...seeded, revision: index + 4, status: 'stale' });
      }
      for (const [index, now] of [
        '2026-08-27T08:00:00.000Z',
        '2026-08-27T09:00:00.000Z',
      ].entries()) {
        vi.setSystemTime(new Date(now));
        republishLastSnapshotStale();
        expect(lastSnapshot(calls)).toEqual({
          ...seeded,
          revision: index + 6,
          status: 'expired',
          running: 0,
          needsInput: 0,
          reconnecting: 0,
          eligibleStartedAt: null,
        });
      }
    } finally {
      unregisterGlanceableSink(sink);
    }
  });

  it.each(['signed_out', 'privacy', 'expired'] as const)(
    'does not replace %s with stale before or after its deadline',
    status => {
      vi.useFakeTimers();
      const terminal: GlanceableAgentsSnapshot = {
        schemaVersion: 1,
        revision: 5,
        updatedAt: '2026-08-27T00:00:00.000Z',
        expiresAt: '2026-08-27T08:00:00.000Z',
        scopeKey: `terminal:${status}`,
        organizationBound: false,
        status,
        running: 0,
        needsInput: 0,
        reconnecting: 0,
        eligibleStartedAt: null,
      };
      _setLastGlanceableSnapshotForTests(terminal);

      const { sink } = makeSink();
      registerGlanceableSink(sink);
      try {
        for (const now of ['2026-08-27T01:00:00.000Z', '2026-08-27T09:00:00.000Z']) {
          vi.setSystemTime(new Date(now));
          republishLastSnapshotStale();
          expect(getLastGlanceableSnapshot()).toMatchObject({
            status,
            scopeKey: terminal.scopeKey,
            updatedAt: terminal.updatedAt,
            expiresAt: terminal.expiresAt,
            running: 0,
            needsInput: 0,
            reconnecting: 0,
            eligibleStartedAt: null,
          });
        }
      } finally {
        unregisterGlanceableSink(sink);
      }
    }
  );
});
