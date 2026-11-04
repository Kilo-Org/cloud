import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  buildOpaqueScopeKey,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS } from '@kilocode/app-shared/home-widget';

import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

import { writeSignedOutSnapshotAndEnd } from './cleanup';
import { createGlanceablePublisher } from './create-publisher';
import {
  _resetHomeWidgetDataForTests,
  getHomeWidgetDataForSnapshot,
  getLastHomeWidgetData,
  rememberHomeWidgetData,
} from './home-widget-data';
import {
  _flushGlanceableMirrorForTests,
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
  _setSecureStoreForTests as _setPersistSecureStoreForTests,
  persistGlanceableSink,
  restorePersistedGlanceable,
} from './persist';
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
const SNAPSHOT_KEY = 'glanceable-snapshot';

const store = new Map<string, string>();

const defaultSetItem = async (key: string, value: string) => {
  store.set(key, value);
  await Promise.resolve();
};

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(defaultSetItem),
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
    _resetHomeWidgetDataForTests();
    _setSecureStoreForTests(secureStoreMock);
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetWaitingAskForTests();
    _resetGlanceablePersistForTests();
    _resetHomeWidgetDataForTests();
    store.clear();
  });

  it('records the waiting ask the activity can action', async () => {
    const publisher = createGlanceablePublisher({ context: CTX });
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
    const publisher = createGlanceablePublisher({ context: CTX });
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
      const publisher = createGlanceablePublisher({ context: CTX });
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

  // A record is adopted only for the scope it names, on the same fence a remote
  // snapshot passes.
  it.each([
    ['another account', { userId: 'u2', organizationId: null }],
    ['another organization of the same account', { userId: 'u1', organizationId: 'org-9' }],
  ])('writes no frame for a restored record of %s', (_label, context) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const restored = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }, { status: 'permission' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 40,
    });
    _setLastGlanceableSnapshotForTests(restored);

    const { sink, snapshots } = makeRecordingSink();
    registerGlanceableSink(sink);
    try {
      const publisher = createGlanceablePublisher({ context });
      // The first read of this context fails before it derived anything.
      publisher.handleFetchError(context);
      expect(snapshots).toEqual([]);

      // The first frame of the new scope still outranks the one the surfaces
      // already hold, so no sink drops it.
      publisher.handleFetchStarted(context);
      expect(snapshots).toEqual([
        expect.objectContaining({
          scopeKey: buildOpaqueScopeKey(context),
          revision: restored.revision + 1,
          status: 'waiting',
        }),
      ]);
      expect(snapshots[0]).toMatchObject({ running: 0, needsInput: 0, needsApproval: 0 });
      publisher.dispose();
    } finally {
      unregisterGlanceableSink(sink);
    }
  });

  // A restart whose stored record names another scope, with the first tray read
  // of the signed-in context failing: the sinks and the Home-only record stay
  // with the signed-in context.
  it('keeps the sinks with the signed-in scope across a restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    _setPersistSecureStoreForTests(secureStoreMock);
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    const first = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }, { status: 'permission' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 3,
    });
    persistGlanceableSink.publish(first);
    rememberHomeWidgetData({
      snapshot: first,
      details: { ...EMPTY_HOME_WIDGET_DETAILS, primaryTitle: 'Quarterly migration' },
    });
    await _flushGlanceableMirrorForTests();

    // The terminal blank meets a keystore that refuses the write.
    secureStoreMock.setItemAsync.mockImplementation(() =>
      Promise.reject(new Error('keystore unavailable'))
    );
    writeSignedOutSnapshotAndEnd();
    await _flushGlanceableMirrorForTests();
    expect(JSON.parse(store.get(SNAPSHOT_KEY) ?? 'null')).toMatchObject({ status: 'happy' });

    // A restart: no in-memory state, the stored record as the failed write left
    // it, and the signed-in identity of the context below.
    _resetGlanceablePersistForTests();
    _resetHomeWidgetDataForTests();
    _setPersistSecureStoreForTests(secureStoreMock);
    secureStoreMock.setItemAsync.mockImplementation(defaultSetItem);
    store.set(ACTIVE_USER_ID_KEY, 'u2');

    await restorePersistedGlanceable();
    expect(getLastHomeWidgetData()).toBeNull();

    const { sink, snapshots } = makeRecordingSink();
    registerGlanceableSink(sink);
    try {
      const next = { userId: 'u2', organizationId: null };
      const publisher = createGlanceablePublisher({ context: next });
      publisher.handleFetchError(next);
      expect(snapshots).toEqual([]);

      publisher.handleFetchStarted(next);
      expect(snapshots).toHaveLength(1);
      const [frame] = snapshots;
      expect(frame).toMatchObject({
        scopeKey: buildOpaqueScopeKey(next),
        revision: first.revision + 1,
        status: 'waiting',
      });
      // The Home-only record follows the signed-in scope of this frame.
      if (frame === undefined) {
        throw new Error('no frame was written');
      }
      expect(getHomeWidgetDataForSnapshot(frame).details.primaryTitle).toBeNull();
      publisher.dispose();
    } finally {
      unregisterGlanceableSink(sink);
    }
  });
});
