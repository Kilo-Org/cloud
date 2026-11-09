/* eslint-disable max-lines -- one cohesive suite shares the fake bridge harness */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake platform bridge and the SecureStore mock settle synchronously */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SystemSearchUpdate } from '@/lib/native-system-search';
import {
  findingSearchDocument,
  storedSessionSearchDocument,
  type SystemSearchDocument,
} from '@/lib/system-search-entries';

// The recents reader is the only storage read in the collector graph; an empty
// list keeps every document in this suite cache-derived.
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

// The stored-history list is the one entity these tests need: a single cached
// page, so one sync has exactly one document to plan from.
const SESSION_LIST_KEY = [
  ['cliSessionsV2', 'list'],
  { type: 'infinite', input: { organizationId: 'org-1' } },
];

const SESSION_ROW = {
  session_id: 'sess-1',
  organization_id: 'org-1',
  git_branch: 'feature/live',
};

/** The document the app's own route builder derives for the fixture row. */
function sessionDocument(title: string): SystemSearchDocument {
  const document = storedSessionSearchDocument({ ...SESSION_ROW, title });
  if (document === null) {
    throw new Error('the fixture session must produce a document');
  }
  return document;
}

function storedSessions(title: string) {
  return { pages: [{ cliSessions: [{ ...SESSION_ROW, title }], nextCursor: null }] };
}

const EMPTY_SESSIONS = { pages: [{ cliSessions: [], nextCursor: null }] };

// The sync's trailing coalescing window: a burst of cache writes inside this
// window must produce exactly one apply.
const COALESCE_MS = 750;

/**
 * A fake platform bridge: the in-memory index moves only through
 * `applyUpdate`, exactly as the device ledger does, and `indexedFingerprints`
 * reports that same ledger back to the sync.
 */
function createBridge(options: { available?: boolean; failFirstApply?: boolean } = {}) {
  const index = new Map<string, SystemSearchDocument>();
  let failNextApply = options.failFirstApply === true;
  const applyUpdate = vi.fn<(update: SystemSearchUpdate) => Promise<void>>();
  applyUpdate.mockImplementation(async update => {
    if (failNextApply) {
      failNextApply = false;
      throw new Error('The system search index did not respond.');
    }
    for (const document of update.add) {
      index.set(document.id, document);
    }
    for (const id of update.removeIds) {
      index.delete(id);
    }
  });
  const indexedFingerprints = vi.fn<() => Promise<Record<string, string>>>();
  indexedFingerprints.mockImplementation(async () =>
    Object.fromEntries([...index].map(([id, document]) => [id, document.fingerprint]))
  );
  // The App Intents catalog, faked the way the device store behaves: a whole
  // list replaces the previous one, and the call reports whether the bytes
  // changed.
  let catalog: { id: string; title: string }[] = [];
  const replaceSessions =
    vi.fn<(entries: readonly { id: string; title: string }[]) => Promise<boolean>>();
  replaceSessions.mockImplementation(async entries => {
    const next = entries.map(entry => ({ id: entry.id, title: entry.title }));
    const changed = JSON.stringify(next) !== JSON.stringify(catalog);
    catalog = next;
    return changed;
  });
  return {
    available: options.available ?? true,
    index,
    applyUpdate,
    indexedFingerprints,
    /** The catalog as the device would hold it. */
    get catalog() {
      return catalog;
    },
    /** The device-side clear the privacy lock and an account boundary fire. */
    clearCatalog() {
      catalog = [];
    },
    replaceSessions,
    // The bridge surface, facing the sync through the same module the mount
    // uses — only the platform module behind it is faked.
    applySystemSearchUpdate: async (update: SystemSearchUpdate) => {
      await applyUpdate(update);
    },
    indexedSystemSearchFingerprints: async () => {
      const fingerprints = await indexedFingerprints();
      return fingerprints;
    },
  };
}

type Bridge = ReturnType<typeof createBridge>;

/**
 * The real module graph with only the platform bridge faked. `isEnabled` is
 * the module's own gate, so the absent-module case exercises it for real.
 */
async function loadHarness(bridge: Bridge) {
  vi.resetModules();
  vi.doMock('@/lib/native-system-search', () => ({
    isSystemSearchAvailable: bridge.available,
    applySystemSearchUpdate: bridge.applySystemSearchUpdate,
    indexedSystemSearchFingerprints: bridge.indexedSystemSearchFingerprints,
  }));
  const [sync, collect] = await Promise.all([
    import('@/lib/system-search-sync'),
    import('@/lib/system-search-collect'),
  ]);
  return {
    SystemSearchIndexSync: sync.SystemSearchIndexSync,
    isSystemSearchSyncEnabled: sync.isSystemSearchSyncEnabled,
    collectSystemSearchDocuments: collect.collectSystemSearchDocuments,
  };
}

type Harness = Awaited<ReturnType<typeof loadHarness>>;

function createSync(harness: Harness, bridge: Bridge, queryClient: QueryClient) {
  const report = vi.fn<(error: unknown) => void>();
  const sync = new harness.SystemSearchIndexSync({
    queryClient,
    collect: async () => harness.collectSystemSearchDocuments(queryClient),
    fingerprints: bridge.indexedSystemSearchFingerprints,
    apply: async update => {
      await bridge.applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
    },
    applySessions: bridge.replaceSessions,
    report,
    isEnabled: harness.isSystemSearchSyncEnabled,
  });
  return { sync, report };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemSearchIndexSync', () => {
  it('applies a seeded session row once and skips a second run', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = createSync(harness, bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.applyUpdate).toHaveBeenCalledExactlyOnceWith({
      add: [sessionDocument('Fix login bug')],
      removeIds: [],
    });
    expect(bridge.index.get(sessionDocument('Fix login bug').id)?.title).toBe('Fix login bug');

    bridge.applyUpdate.mockClear();
    await expect(sync.syncNow()).resolves.toBe('skipped');
    expect(bridge.applyUpdate).not.toHaveBeenCalled();
  });

  it('applies a remove for a row the cache no longer carries', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = createSync(harness, bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('applied');
    const id = sessionDocument('Fix login bug').id;
    expect(bridge.index.has(id)).toBe(true);

    queryClient.setQueryData(SESSION_LIST_KEY, EMPTY_SESSIONS);
    await expect(sync.syncNow()).resolves.toBe('applied');

    expect(bridge.applyUpdate).toHaveBeenLastCalledWith({ add: [], removeIds: [id] });
    expect(bridge.index.has(id)).toBe(false);
  });

  it('keeps an indexed entry whose source family the cache cannot enumerate', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const finding = findingSearchDocument({ id: 'f-1', title: 'SQL injection' }, 'personal');
    bridge.index.set(finding.id, finding);
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = createSync(harness, bridge, queryClient);

    // The findings query is absent — a cold start hydrates only some queries —
    // so its indexed entries are kept, not dropped as if the user lost them.
    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.index.has(finding.id)).toBe(true);

    // Once the findings query is in the cache and successful, its absence from
    // the documents is evidence the user can no longer see the finding. The
    // screen builds the list key as `[...queryKey(), filters]`, so the
    // unfiltered filters segment sits in the third position.
    queryClient.setQueryData([['securityAgent', 'listFindings'], { type: 'query' }, {}], {
      pages: [{ findings: [], totalCount: 0 }],
    });
    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.index.has(finding.id)).toBe(false);
  });

  it('keeps an indexed finding when only the bounded capacity probe is cached', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const finding = findingSearchDocument({ id: 'f-1', title: 'SQL injection' }, 'personal');
    bridge.index.set(finding.id, finding);
    // The findings screen also mounts `useSecurityAnalysisCapacity`, which
    // fetches `listFindings` with `{ status: 'open', limit: 1 }` under the same
    // query path. Its success enumerates no findings, so it must not be taken
    // as evidence that the indexed finding is gone.
    queryClient.setQueryData(
      [
        ['securityAgent', 'listFindings'],
        { type: 'query', input: { status: 'open', limit: 1, offset: 0 } },
      ],
      { findings: [], totalCount: 3, runningCount: 0, concurrencyLimit: 3 }
    );
    const { sync } = createSync(harness, bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('skipped');
    expect(bridge.index.has(finding.id)).toBe(true);
  });

  it('reports a rejected apply once, keeps the index, and retries on the next trigger', async () => {
    const bridge = createBridge({ failFirstApply: true });
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync, report } = createSync(harness, bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('failed');
    expect(bridge.applyUpdate).toHaveBeenCalledOnce();
    expect(bridge.index.size).toBe(0);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.any(Error));

    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.applyUpdate).toHaveBeenCalledTimes(2);
    expect(bridge.index.get(sessionDocument('Fix login bug').id)?.title).toBe('Fix login bug');
    expect(report).toHaveBeenCalledOnce();
  });

  it('makes no native call at all when the module is absent', async () => {
    const bridge = createBridge({ available: false });
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = createSync(harness, bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('skipped');
    expect(bridge.applyUpdate).not.toHaveBeenCalled();
    expect(bridge.indexedFingerprints).not.toHaveBeenCalled();
  });

  it('skips while a sign-out teardown is in flight', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = createSync(harness, bridge, queryClient);
    const signOut = await import('@/lib/auth/sign-out-state');

    signOut.setSignOutActive(true);
    try {
      await expect(sync.syncNow()).resolves.toBe('skipped');
      expect(bridge.applyUpdate).not.toHaveBeenCalled();
    } finally {
      signOut.setSignOutActive(false);
    }
  });

  it('skips a write whose collect spanned a sign-out', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const signOut = await import('@/lib/auth/sign-out-state');
    const report = vi.fn<(error: unknown) => void>();
    // The gate is read once before the collect and again before the write; the
    // sign-out begins while the collect is in flight, and the teardown fires
    // its own native clear, which this run's plan must not undo.
    const sync = new harness.SystemSearchIndexSync({
      queryClient,
      collect: async () => {
        signOut.setSignOutActive(true);
        return harness.collectSystemSearchDocuments(queryClient);
      },
      fingerprints: bridge.indexedSystemSearchFingerprints,
      apply: async update => {
        await bridge.applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
      },
      report,
      isEnabled: harness.isSystemSearchSyncEnabled,
    });

    try {
      await expect(sync.syncNow()).resolves.toBe('skipped');
      expect(bridge.applyUpdate).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      signOut.setSignOutActive(false);
    }
  });

  it('skips a write whose collect spanned an account switch', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const authEpoch = await import('@/lib/auth/auth-epoch');
    // A sign-out that finished (or a newer sign-in) moves the auth epoch while
    // the collect is in flight: the gate is open again by then, so only the
    // epoch fence can refuse this run's now-stale documents.
    const sync = new harness.SystemSearchIndexSync({
      queryClient,
      collect: async () => {
        authEpoch.bumpAuthEpoch();
        return harness.collectSystemSearchDocuments(queryClient);
      },
      fingerprints: bridge.indexedSystemSearchFingerprints,
      apply: async update => {
        await bridge.applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
      },
      report: vi.fn<(error: unknown) => void>(),
      isEnabled: harness.isSystemSearchSyncEnabled,
    });

    await expect(sync.syncNow()).resolves.toBe('skipped');
    expect(bridge.applyUpdate).not.toHaveBeenCalled();
  });

  it('coalesces a burst of cache events into one apply', async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const { sync } = createSync(harness, bridge, queryClient);
    const detach = sync.attach();

    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('First title'));
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Second title'));
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Third title'));
    expect(bridge.applyUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await sync.getRunQueue();

    expect(bridge.applyUpdate).toHaveBeenCalledOnce();
    const id = sessionDocument('Third title').id;
    expect(bridge.index.get(id)?.title).toBe('Third title');
    detach();
  });

  it('runs a sustained burst without waiting for it to end', async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const { sync } = createSync(harness, bridge, queryClient);
    const detach = sync.attach();

    // A cache write every 300 ms re-arms the 750 ms trailing timer every time,
    // so a trailing-only debounce never fires while the stream lasts. The
    // writes are scheduled on the fake clock so the loop itself never awaits.
    for (let tick = 0; tick < 18; tick += 1) {
      setTimeout(() => {
        queryClient.setQueryData(SESSION_LIST_KEY, storedSessions(`Burst ${tick}`));
      }, tick * 300);
    }
    // Stop just past the 5000 ms maximum-wait deadline, before the trailing
    // timer re-armed by the last write (5100 + 750 ms) and before the previous
    // write's own trailing timer (4800 + 750 ms) could fire. Only the max-wait
    // cap can have applied a sync by now, so this fails if the cap is removed.
    await vi.advanceTimersByTimeAsync(18 * 300);
    await sync.getRunQueue();

    expect(bridge.applyUpdate).toHaveBeenCalled();
    expect(bridge.index.size).toBeGreaterThan(0);
    detach();
  });

  it('drops the cache subscription on detach', async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const { sync } = createSync(harness, bridge, queryClient);
    const detach = sync.attach();
    detach();

    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await sync.getRunQueue();

    expect(bridge.applyUpdate).not.toHaveBeenCalled();
  });

  it('resolves failed instead of rejecting when a dependency throws', async () => {
    const bridge = createBridge();
    const harness = await loadHarness(bridge);
    const queryClient = new QueryClient();
    const report = vi.fn<(error: unknown) => void>(() => {
      throw new Error('the reporter is broken');
    });
    const sync = new harness.SystemSearchIndexSync({
      queryClient,
      collect: async () => ({ documents: [], sessions: null, observedSources: new Set() }),
      fingerprints: bridge.indexedSystemSearchFingerprints,
      apply: async () => undefined,
      report,
      isEnabled: () => {
        throw new Error('the gate is broken');
      },
    });

    // A throwing gate and a throwing reporter both resolve to `failed`:
    // `syncNow` never rejects at its fire-and-forget call sites.
    await expect(sync.syncNow()).resolves.toBe('failed');
    expect(report).toHaveBeenCalledOnce();
    expect(bridge.applyUpdate).not.toHaveBeenCalled();
  });
});

describe('the App Intents session catalog a run publishes', () => {
  /** A sync whose collect step runs `duringCollect` before it answers. */
  async function syncWithCatalog(
    bridge: Bridge,
    queryClient: QueryClient,
    duringCollect: () => void | Promise<void> = () => undefined
  ) {
    const harness = await loadHarness(bridge);
    const report = vi.fn<(error: unknown) => void>();
    const sync = new harness.SystemSearchIndexSync({
      queryClient,
      collect: async () => {
        await duringCollect();
        return harness.collectSystemSearchDocuments(queryClient);
      },
      fingerprints: bridge.indexedSystemSearchFingerprints,
      apply: async update => {
        await bridge.applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
      },
      applySessions: bridge.replaceSessions,
      report,
      isEnabled: harness.isSystemSearchSyncEnabled,
    });
    return { sync, report };
  }

  it('publishes the run’s titles beside the index write', async () => {
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient);

    await expect(sync.syncNow()).resolves.toBe('applied');

    expect(bridge.replaceSessions).toHaveBeenCalledExactlyOnceWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    expect(bridge.catalog).toEqual([{ id: 'sess-1', title: 'Fix login bug' }]);
  });

  it('republishes the titles when only the catalog was cleared', async () => {
    // The privacy lock wipes the catalog and leaves the index ledger alone, so
    // the next run has an empty plan and still has to restore the picker.
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient);
    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.catalog).toEqual([{ id: 'sess-1', title: 'Fix login bug' }]);

    bridge.clearCatalog();
    bridge.replaceSessions.mockClear();
    bridge.applyUpdate.mockClear();

    await expect(sync.syncNow()).resolves.toBe('applied');

    expect(bridge.applyUpdate).not.toHaveBeenCalled();
    expect(bridge.catalog).toEqual([{ id: 'sess-1', title: 'Fix login bug' }]);
  });

  it('keeps the titles out of a run whose collect spanned a sign-out', async () => {
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient, async () => {
      // Imported inside the collect, after the harness reset the module
      // registry: a static import would bind the pre-reset sign-out flag and
      // the fence would never move.
      const signOut = await import('@/lib/auth/sign-out-state');
      signOut.setSignOutActive(true);
    });

    try {
      await expect(sync.syncNow()).resolves.toBe('skipped');
      expect(bridge.replaceSessions).not.toHaveBeenCalled();
      expect(bridge.catalog).toEqual([]);
    } finally {
      const signOut = await import('@/lib/auth/sign-out-state');
      signOut.setSignOutActive(false);
    }
  });

  it('keeps the titles out of a run whose collect spanned an account switch', async () => {
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient, async () => {
      const authEpoch = await import('@/lib/auth/auth-epoch');
      authEpoch.bumpAuthEpoch();
    });

    await expect(sync.syncNow()).resolves.toBe('skipped');
    expect(bridge.replaceSessions).not.toHaveBeenCalled();
    expect(bridge.catalog).toEqual([]);
  });

  it('keeps the stored titles when no sessions read settled in the run', async () => {
    // A cold launch collects an empty cache before the stored history answers.
    // The run must not hand the device an empty catalog: that drops the titles
    // every saved shortcut resolves against.
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient);
    await expect(sync.syncNow()).resolves.toBe('applied');
    expect(bridge.catalog).toEqual([{ id: 'sess-1', title: 'Fix login bug' }]);

    // The next launch collects before the list has loaded again.
    queryClient.clear();
    bridge.replaceSessions.mockClear();

    await sync.syncNow();

    expect(bridge.replaceSessions).not.toHaveBeenCalled();
    expect(bridge.catalog).toEqual([{ id: 'sess-1', title: 'Fix login bug' }]);
  });

  it('clears the stored titles when a settled read returns no sessions', async () => {
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync } = await syncWithCatalog(bridge, queryClient);
    await expect(sync.syncNow()).resolves.toBe('applied');

    queryClient.setQueryData(SESSION_LIST_KEY, { pages: [{ cliSessions: [], nextCursor: null }] });
    bridge.replaceSessions.mockClear();

    await sync.syncNow();

    expect(bridge.replaceSessions).toHaveBeenCalledExactlyOnceWith([]);
    expect(bridge.catalog).toEqual([]);
  });

  it('still writes the index when the catalog write fails, and reports once', async () => {
    const bridge = createBridge();
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_LIST_KEY, storedSessions('Fix login bug'));
    const { sync, report } = await syncWithCatalog(bridge, queryClient);
    bridge.replaceSessions.mockRejectedValueOnce(new Error('the catalog store refused'));

    await expect(sync.syncNow()).resolves.toBe('failed');

    expect(bridge.applyUpdate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(bridge.catalog).toEqual([]);
  });
});
