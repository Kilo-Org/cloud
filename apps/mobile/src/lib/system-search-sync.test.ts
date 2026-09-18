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
  return {
    available: options.available ?? true,
    index,
    applyUpdate,
    indexedFingerprints,
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
      collect: async () => ({ documents: [], observedSources: new Set() }),
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
