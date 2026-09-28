import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { writeSignedOutSnapshotAndEnd } from './cleanup';
import { createGlanceablePublisher } from './create-publisher';
import { _resetGlanceablePersistForTests, _setLastGlanceableSnapshotForTests } from './persist';
import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';
import {
  _flushWaitingAskMirrorForTests,
  _resetWaitingAskForTests,
  _setSecureStoreForTests,
  getWaitingAsk,
} from './waiting-ask';

const NOW = 1_750_000_000_000;
const CTX = { userId: 'u1', organizationId: null };
const ASK_KEY = 'glanceable-waiting-ask';

const store = new Map<string, string>();

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

function makeRecordingSink(): { sink: GlanceableSink; snapshots: GlanceableAgentsSnapshot[] } {
  const snapshots: GlanceableAgentsSnapshot[] = [];
  const sink: GlanceableSink = {
    publish(snapshot) {
      snapshots.push(snapshot);
    },
    startOrUpdate(snapshot) {
      snapshots.push(snapshot);
    },
    endImmediate() {
      // The fake owns no native surface.
    },
  };
  return { sink, snapshots };
}

describe('createGlanceablePublisher', () => {
  beforeEach(() => {
    _resetWaitingAskForTests();
    _resetGlanceablePersistForTests();
    _setSecureStoreForTests(secureStoreMock);
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetWaitingAskForTests();
    _resetGlanceablePersistForTests();
    store.clear();
  });

  it('records the waiting ask the activity can action', async () => {
    const publisher = createGlanceablePublisher();
    publisher.handleSessions(
      [
        { id: 'busy', status: 'busy' },
        {
          id: 'waiting',
          status: 'permission',
          statusUpdatedAt: new Date(NOW - 1000).toISOString(),
        },
      ],
      CTX
    );
    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'waiting', status: 'permission' });
    await _flushWaitingAskMirrorForTests();
    expect(store.get(ASK_KEY)).toBe(JSON.stringify(getWaitingAsk()));

    publisher.handleSessions([{ id: 'busy', status: 'busy' }], CTX);
    expect(getWaitingAsk()).toBeNull();
    publisher.dispose();
  });

  it('clears the ask once a terminal blank gates the publisher', () => {
    const publisher = createGlanceablePublisher();
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], CTX);
    expect(getWaitingAsk()).not.toBeNull();

    writeSignedOutSnapshotAndEnd();
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], CTX);
    expect(getWaitingAsk()).toBeNull();
    publisher.dispose();
  });

  it('seeds the revision from the persisted last snapshot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const seeded = buildGlanceableSnapshot({
      sessions: [],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 4,
    });
    _setLastGlanceableSnapshotForTests(seeded);

    const { sink, snapshots } = makeRecordingSink();
    registerGlanceableSink(sink);
    try {
      const publisher = createGlanceablePublisher();
      publisher.handleFetchError(CTX);
      expect(snapshots.at(-1)).toMatchObject({
        revision: seeded.revision + 1,
        status: 'stale',
      });
      publisher.dispose();
    } finally {
      unregisterGlanceableSink(sink);
    }
  });
});
