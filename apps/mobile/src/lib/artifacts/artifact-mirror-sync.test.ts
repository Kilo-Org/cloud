/* eslint-disable max-lines -- one cohesive suite for the sync engine: gating, single-flight, crawl convergence, the byte budget, and the sign-out fence share one harness */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake list, page, KV, and download seams resolve immediately, so they settle without await */
import { Directory, File } from 'expo-file-system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactMirrorSyncDeps,
  MAX_SESSIONS_PER_RUN,
  MIRROR_BYTE_BUDGET,
  MIRROR_SESSION_LIMIT,
  MIRROR_SYNC_MIN_INTERVAL_MS,
  resetArtifactMirrorSyncState,
  syncArtifactMirror,
} from '@/lib/artifacts/artifact-mirror-sync';
import { type ArtifactMirrorManifest } from '@/lib/artifacts/artifact-mirror-manifest';
import { setSignOutActive } from '@/lib/auth/sign-out-state';

// Real-entry-shaped stand-in for expo-file-system: an entry is a File (the
// mirror sets `size` and calls `delete`) and a Directory (the sync creates the
// session folder before materializing into it).
const fakeFs = vi.hoisted(() => {
  type Tracked = { created: boolean; deleted: boolean; size: number };
  const entries: Tracked[] = [];

  class EntryMock {
    created = false;
    deleted = false;
    size = 0;

    constructor() {
      entries.push(this);
    }

    create(): void {
      this.created = true;
    }

    delete(): void {
      this.deleted = true;
    }
  }

  return {
    Directory: EntryMock,
    File: EntryMock,
    entries,
    reset: () => {
      entries.length = 0;
    },
  };
});

vi.mock('expo-file-system', () => ({
  Directory: fakeFs.Directory,
  File: fakeFs.File,
  Paths: {},
}));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
// `artifact-mirror-paths` is the only Platform.OS branch; the sync never reads
// it because `mirrorSessionDir` is injected, but the import must resolve.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
  deleteItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: { getSessionMessagesPage: { query: vi.fn() }, list: { query: vi.fn() } },
    cloudAgentNext: { getAttachmentDownloadUrl: { mutate: vi.fn() } },
  },
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  clearScope: vi.fn(),
  clearScopePrefix: vi.fn(),
  getItem: vi.fn(),
  listEntries: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));

const USER_ID = 'user-1';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const NOW = 1_700_000_000_000;

type SessionInput = { id: string; updatedAt: string };
type FileInput = { id: string; size: number; url: string };

/** A completed download: a fresh File carrying `size` bytes. */
function downloaded(size: number): File {
  const file = new File();
  const tracked = fakeFs.entries.at(-1);
  if (tracked) {
    tracked.size = size;
  }
  return file;
}

/** Point each artifact's URL at a completed download of its size. */
function registerDownloads(h: ReturnType<typeof harness>, files: FileInput[]): void {
  for (const file of files) {
    h.downloads.set(file.url, async () => downloaded(file.size));
  }
}

/** One stored message carrying a `file` part per artifact id. */
function messageOf(ids: string[]): { parts: unknown[] } {
  return {
    parts: ids.map(id => ({ id, mime: 'text/plain', type: 'file', url: `https://x/${id}` })),
  };
}

/** Point one session's next stored page at `files`, and its downloads at a hit. */
function setFiles(h: ReturnType<typeof harness>, sessionId: string, files: FileInput[]): void {
  registerDownloads(h, files);
  h.pages.set(sessionId, {
    messages: [
      {
        info: { id: 'message-1' },
        parts: files.map(file => ({
          id: file.id,
          mime: 'text/plain',
          type: 'file',
          url: file.url,
        })),
      },
    ],
    nextCursor: null,
  });
}

function harness(overrides: Partial<ArtifactMirrorSyncDeps> = {}) {
  const store = new Map<string, string>();
  const applied: ArtifactMirrorManifest[] = [];
  const sessions: SessionInput[] = [];
  const pages = new Map<string, { messages: unknown[]; nextCursor: string | null }>();
  const downloads = new Map<string, () => Promise<File>>();
  const notify = vi.fn<() => void>();
  let now = NOW;

  const listSessions = vi.fn(async () => ({
    cliSessions: sessions.map(session => ({
      session_id: session.id,
      title: `Session ${session.id}`,
      updated_at: session.updatedAt,
    })),
    nextCursor: null,
  }));
  const getSessionMessagesPage = vi.fn(async (input: { session_id: string }) => {
    const page = pages.get(input.session_id) ?? { messages: [], nextCursor: null };
    return { history: { messages: page.messages, nextCursor: page.nextCursor } };
  });
  const downloadFile = vi.fn(async (url: string) => {
    const download = downloads.get(url);
    if (!download) {
      throw new Error(`unexpected download: ${url}`);
    }
    return download();
  });

  const deps: ArtifactMirrorSyncDeps = {
    applySnapshot: manifest => {
      applied.push(manifest);
    },
    downloadFile,
    getSessionMessagesPage,
    listSessions,
    mirrorSessionDir: () => new Directory('file:///mirror/sessions'),
    notify,
    now: () => now,
    presignAttachmentDownload: vi.fn(async () => ({ signedUrl: 'https://x/signed' })),
    readState: async (scope, key) => store.get(`${scope}/${key}`) ?? null,
    resolveUserId: () => USER_ID,
    writeState: async (scope, key, value) => {
      store.set(`${scope}/${key}`, value);
    },
    ...overrides,
  };

  return {
    applied,
    deps,
    downloadFile,
    downloads,
    getSessionMessagesPage,
    listSessions,
    notify,
    pages,
    sessions,
    store,
    lastManifest: (): ArtifactMirrorManifest => {
      const manifest = applied.at(-1);
      if (!manifest) {
        throw new Error('no snapshot was applied');
      }
      return manifest;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

/** The artifact ids one session's folder holds in a snapshot. */
function sessionFiles(manifest: ArtifactMirrorManifest, sessionId: string): string[] {
  const session = manifest.sessions.find(entry => entry.id === sessionId);
  return session?.files.map(file => file.id) ?? [];
}

function sessionIds(manifest: ArtifactMirrorManifest): string[] {
  return manifest.sessions.map(session => session.id);
}

beforeEach(() => {
  resetArtifactMirrorSyncState();
  setSignOutActive(false);
  fakeFs.reset();
  vi.clearAllMocks();
});

describe('syncArtifactMirror gating', () => {
  it('gates a second run on the interval and lets force through', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({ status: 'synced' });
    // One list page is the whole known session set.
    expect(h.listSessions).toHaveBeenCalledWith({
      limit: MIRROR_SESSION_LIMIT,
      orderBy: 'updated_at',
    });
    // A completed run tells the platform provider the tree changed.
    expect(h.notify).toHaveBeenCalledOnce();

    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS - 1);
    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({
      status: 'skipped',
      reason: 'interval',
    });
    expect(h.listSessions).toHaveBeenCalledTimes(1);

    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
    });
    expect(h.listSessions).toHaveBeenCalledTimes(2);

    // The forced run re-stamped `lastRunAt`, so the next unforced call must
    // wait a full interval from that run, not from the first one.
    h.setNow(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({ status: 'synced' });
    expect(h.listSessions).toHaveBeenCalledTimes(3);
  });

  it('returns the running promise instead of starting a second run', async () => {
    // The first run parks inside `listSessions` until the test releases it, so
    // the second call must observe a run that is still in flight.
    const release = vi.fn<() => void>();
    const gate = new Promise<void>(resolve => {
      release.mockImplementation(resolve);
    });
    const listSessions = vi.fn(async () => {
      await gate;
      return { cliSessions: [], nextCursor: null };
    });
    const h = harness({ listSessions });

    const first = syncArtifactMirror({ force: true, deps: h.deps });
    const second = syncArtifactMirror({ force: true, deps: h.deps });

    expect(second).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ status: 'synced' });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('skips without a signed-in user', async () => {
    const h = harness({ resolveUserId: () => null });

    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toEqual({
      status: 'skipped',
      reason: 'no-user',
    });
    expect(h.listSessions).not.toHaveBeenCalled();
  });
});

describe('syncArtifactMirror crawling', () => {
  it('keeps the previous mirror when a download fails and retries it next run', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);

    await syncArtifactMirror({ deps: h.deps });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);

    // The session changed: the page is re-read from the top, the already
    // materialized file is skipped, and the second download fails.
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: 'https://x/f1' },
      { id: 'f2', size: 10, url: 'https://x/f2' },
    ]);
    h.downloads.set('https://x/f2', async () => {
      throw new Error('offline');
    });
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(h.downloadFile).toHaveBeenCalledWith('https://x/f2', expect.anything());

    // The retry: the held cursor re-reads the same page and f2 lands.
    h.downloads.set('https://x/f2', async () => downloaded(10));
    h.setNow(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1', 'f2']);
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(3);
  });

  it('does not re-fetch a session whose crawl is done', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);

    await syncArtifactMirror({ deps: h.deps });
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(1);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
  });

  it('restarts a session whose head changed while its crawl was in progress', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    registerDownloads(h, [
      { id: 'f1', size: 10, url: 'https://x/f1' },
      { id: 'f2', size: 10, url: 'https://x/f2' },
      { id: 'f3', size: 10, url: 'https://x/f3' },
    ]);
    // Page one (no cursor) holds the head; page two is reached by its cursor.
    let head = ['f1'];
    h.deps.getSessionMessagesPage = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === undefined
        ? { history: { messages: [messageOf(head)], nextCursor: 'c1' } }
        : { history: { messages: [messageOf(['f3'])], nextCursor: null } }
    );

    // Run one reads page one and leaves the crawl mid-way.
    await syncArtifactMirror({ deps: h.deps });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);

    // The session gains a message while the crawl is mid-way. The saved cursor
    // would hide the new head, so the next run must restart from page one.
    head = ['f1', 'f2'];
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1', 'f2']);
    // The restart re-reads page one but never re-downloads what it already has.
    expect(h.downloadFile.mock.calls.filter(([url]) => url === 'https://x/f1')).toHaveLength(1);
  });

  it('does not record a failed page as a finished crawl and retries it next run', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    registerDownloads(h, [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
    let failure: string | null = 'retryable_failure';
    const getSessionMessagesPage = vi.fn(async () =>
      failure === null
        ? { history: { messages: [messageOf(['f1'])], nextCursor: null } }
        : { history: { kind: failure } }
    );
    h.deps.getSessionMessagesPage = getSessionMessagesPage;
    let runAt = NOW;

    // Neither a retryable failure nor a terminal one is proof that a session
    // has no artifacts: both hold the crawl so the page is read again.
    for (const kind of ['retryable_failure', 'invalid_data']) {
      failure = kind;
      // eslint-disable-next-line no-await-in-loop -- each run must see the state and clock the run before it left
      expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
        status: 'synced',
        failed: 1,
        files: 0,
      });
      expect(sessionIds(h.lastManifest())).toEqual(['s1']);
      expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);
      runAt += MIRROR_SYNC_MIN_INTERVAL_MS;
      h.setNow(runAt);
    }

    // The page arrives at last: the held cursor re-reads it and f1 lands.
    failure = null;
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(getSessionMessagesPage).toHaveBeenCalledTimes(3);
  });

  it('advances at most MAX_SESSIONS_PER_RUN sessions per run', async () => {
    const h = harness();
    h.sessions.push(
      { id: 's1', updatedAt: T1 },
      { id: 's2', updatedAt: T1 },
      { id: 's3', updatedAt: T1 },
      { id: 's4', updatedAt: T1 }
    );
    for (const session of h.sessions) {
      setFiles(h, session.id, [
        { id: `${session.id}-f1`, size: 10, url: `https://x/${session.id}` },
      ]);
    }

    await syncArtifactMirror({ deps: h.deps });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(MAX_SESSIONS_PER_RUN);
    expect(sessionIds(h.lastManifest())).toEqual(['s1', 's2', 's3', 's4']);

    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(4);
  });

  it('prunes a session that left the list page', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 }, { id: 's2', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
    setFiles(h, 's2', [{ id: 'f2', size: 10, url: 'https://x/f2' }]);

    await syncArtifactMirror({ deps: h.deps });
    expect(sessionIds(h.lastManifest())).toEqual(['s1', 's2']);

    h.sessions.length = 1;
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    expect(sessionIds(h.lastManifest())).toEqual(['s1']);
  });

  it('drops the oldest session files over the byte budget but keeps its folder', async () => {
    const perFile = Math.floor(MIRROR_BYTE_BUDGET / 10);
    const h = harness();
    h.sessions.push({ id: 'newer', updatedAt: T2 }, { id: 'older', updatedAt: T1 });
    setFiles(
      h,
      'newer',
      Array.from({ length: 10 }, (_, index) => ({
        id: `n${index}`,
        size: perFile,
        url: `https://x/n${index}`,
      }))
    );
    setFiles(h, 'older', [{ id: 'o1', size: perFile, url: 'https://x/o1' }]);

    await syncArtifactMirror({ deps: h.deps });

    const manifest = h.lastManifest();
    expect(sessionIds(manifest)).toEqual(['newer', 'older']);
    expect(sessionFiles(manifest, 'newer')).toHaveLength(10);
    expect(sessionFiles(manifest, 'older')).toEqual([]);
  });

  it('discards a run that resolves after a sign-out and writes nothing', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
    const original = h.getSessionMessagesPage;
    h.deps.getSessionMessagesPage = vi.fn(async (input: { session_id: string }) => {
      setSignOutActive(true);
      return original(input);
    });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'discarded' });
    expect(h.applied).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });

  it('removes the bytes a download wrote when a sign-out lands inside the download', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
    // The sign-out lands inside the download await itself, past the fence that
    // gated starting it, so only the post-await fence can stop the bytes that
    // arrive after teardown already deleted the mirror.
    const targets: { deleted: boolean }[] = [];
    h.deps.downloadFile = vi.fn(async (_url: string, target: File) => {
      setSignOutActive(true);
      targets.push(target as unknown as { deleted: boolean });
      return downloaded(10);
    });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'discarded' });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.deleted).toBe(true);
    expect(h.applied).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });

  it('does not signal the provider when a sign-out lands inside the state write', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
    h.deps.writeState = vi.fn(async () => {
      setSignOutActive(true);
    });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'discarded' });
    // The teardown clears the mirror, so the run stops before telling an open
    // browser to re-query a location that no longer holds anything.
    expect(h.notify).not.toHaveBeenCalled();
  });
});
