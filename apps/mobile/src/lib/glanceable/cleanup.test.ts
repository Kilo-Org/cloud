import { afterEach, describe, expect, it } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  planOrgFenceAction,
  republishLastSnapshotStale,
  writePrivacySnapshotAndEnd,
  writeSignedOutSnapshotAndEnd,
} from './cleanup';
import { _resetGlanceablePersistForTests, _setLastGlanceableSnapshotForTests } from './persist';
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

  it('marks stale (keeps counts) when the org list errors', () => {
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
      organizationBound: false,
      status: 'happy',
      running: 2,
      needsInput: 1,
      reconnecting: 0,
      eligibleStartedAt: '2026-08-26T23:00:00.000Z',
    };
    _setLastGlanceableSnapshotForTests(seeded);

    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    try {
      republishLastSnapshotStale();
      const snapshot = lastSnapshot(calls);
      expect(snapshot.status).toBe('stale');
      expect(snapshot.running).toBe(2);
      expect(snapshot.needsInput).toBe(1);
      expect(snapshot.revision).toBe(4);
    } finally {
      unregisterGlanceableSink(sink);
    }
  });

  it('does not overwrite a terminal blank with a stale republish', () => {
    const terminal: GlanceableAgentsSnapshot = {
      schemaVersion: 1,
      revision: 5,
      updatedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-27T08:00:00.000Z',
      scopeKey: 'terminal:privacy',
      organizationBound: false,
      status: 'privacy',
      running: 0,
      needsInput: 0,
      reconnecting: 0,
      eligibleStartedAt: null,
    };
    _setLastGlanceableSnapshotForTests(terminal);

    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    try {
      republishLastSnapshotStale();
      expect(calls).toEqual([]);
    } finally {
      unregisterGlanceableSink(sink);
    }
  });
});
