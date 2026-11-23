/* eslint-disable max-lines -- one cohesive suite for the sync engine: gating, single-flight, crawl convergence, the byte budget, and the sign-out fence share one harness */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake list, page, KV, and download seams resolve immediately, so they settle without await */
import { Directory, File } from 'expo-file-system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactMirrorSyncDeps,
  MAX_ARTIFACT_ATTEMPTS,
  MAX_SESSIONS_PER_RUN,
  MIRROR_BYTE_BUDGET,
  MIRROR_SESSION_LIMIT,
  MIRROR_SYNC_MIN_INTERVAL_MS,
  resetArtifactMirrorSyncState,
  syncArtifactMirror,
} from '@/lib/artifacts/artifact-mirror-sync';
import { MAX_ARTIFACT_BYTES } from '@/lib/artifacts/artifact-crawl';
import { type ArtifactMirrorManifest } from '@/lib/artifacts/artifact-mirror-manifest';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { readCacheScope } from '@/lib/persist/cache-scope';

// Real-entry-shaped stand-in for expo-file-system: an entry is a File (the
// mirror sets `size`, promotes with `moveSync` and calls `delete`) and a
// Directory (the sync creates the session folder before materializing into it).
// It tracks paths as well as instances: the fence's job is to not remove a path
// a later generation wrote, so a delete has to be visible at the path, not only
// on the instance that called it.
const fakeFs = vi.hoisted(() => {
  type Tracked = { created: boolean; deleted: boolean; path: string; size: number };
  const entries: Tracked[] = [];
  const createdPaths = new Set<string>();
  const deletedPaths = new Set<string>();

  class EntryMock {
    created = false;
    deleted = false;
    path: string;
    size = 0;
    writes = 0;

    constructor(...parts: unknown[]) {
      // The `downloaded` stand-in is built with no arguments; give it a unique
      // path so its size bookkeeping cannot collide with a mirror entry.
      this.path =
        parts.length === 0
          ? `download-${entries.length}`
          : parts
              .map(part =>
                typeof part === 'string' ? part : ((part as { path?: string }).path ?? '')
              )
              .join('/');
      entries.push(this);
    }

    // Path-based, like the real filesystem: a reader that builds a fresh entry
    // for a path sees what an earlier entry wrote there.
    get exists(): boolean {
      return createdPaths.has(this.path) && !deletedPaths.has(this.path);
    }

    create(): void {
      this.created = true;
      createdPaths.add(this.path);
    }

    // A `data:` URL writes its decoded payload through this; the sync suite
    // only tracks the resulting size, not the bytes.
    write(): void {
      this.writes += 1;
    }

    delete(): void {
      this.deleted = true;
      deletedPaths.add(this.path);
    }

    moveSync(destination: EntryMock): void {
      this.deleted = true;
      deletedPaths.add(this.path);
      destination.created = true;
      createdPaths.add(destination.path);
    }
  }

  return {
    Directory: EntryMock,
    File: EntryMock,
    created: (path: string) => createdPaths.has(path),
    deleted: (path: string) => deletedPaths.has(path),
    /** Removes bytes the way the device does: outside the sync's own writes. */
    remove: (path: string) => {
      deletedPaths.add(path);
    },
    entries,
    reset: () => {
      entries.length = 0;
      createdPaths.clear();
      deletedPaths.clear();
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
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
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
  getItemWithUpdatedAt: vi.fn(),
  listEntries: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));

/** The R2 S3 origin every Kilo artifact presign names: the only host the crawl downloads from. */
const STORAGE_ORIGIN = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

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
    parts: ids.map(id => ({
      id,
      mime: 'text/plain',
      type: 'file',
      url: `${STORAGE_ORIGIN}/${id}`,
    })),
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
  // What the snapshot reports about the tree it found. This suite keeps paths in
  // a set, not a real tree, so a case that needs the snapshot to have repaired
  // something says so instead of modelling the repair; anything else gets the
  // report of a snapshot that found the tree as it left it.
  let repaired = false;
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
      return repaired;
    },
    downloadFile,
    getSessionMessagesPage,
    listSessions,
    mirrorSessionDir: () => new Directory('file:///mirror/sessions'),
    notify,
    now: () => now,
    presignAttachmentDownload: vi.fn(async () => ({ signedUrl: `${STORAGE_ORIGIN}/signed` })),
    probeContentLength: vi.fn(async () => null),
    readState: async (scope, key) => store.get(`${scope}/${key}`) ?? null,
    // The index on disk is whatever the last applied snapshot set it to: the
    // mirror writes exactly the bytes it was handed, so a second run sees the
    // first run's manifest the way the device would.
    readSnapshot: (): ArtifactMirrorManifest | null => applied.at(-1) ?? null,
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
    setRepaired: (value: boolean) => {
      repaired = value;
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

type StoredSessionState = {
  attempts: Record<string, number>;
  cursor: string | null;
  done: boolean;
  files: { id: string }[];
  lastAdvancedAt: number | null;
  terminal: Record<string, string>;
  updatedAt: string;
};

/** The key the sync engine reads and writes its state under for `USER_ID`. */
const SYNC_STATE_KEY = `${readCacheScope(USER_ID)}/artifact-mirror:${USER_ID}`;

/** The crawl state one session has in the persisted row, read as the run wrote it. */
function storedSession(store: Map<string, string>, sessionId: string): StoredSessionState {
  const raw = store.get(SYNC_STATE_KEY);
  if (raw === undefined) {
    throw new Error('no state was persisted');
  }
  // The row is the engine's own JSON round trip, so this reads it back at the
  // shape the engine wrote instead of re-deriving it here.
  const row = JSON.parse(raw) as { sessions: Record<string, StoredSessionState> };
  const state = row.sessions[sessionId];
  if (state === undefined) {
    throw new Error(`no state was persisted for ${sessionId}`);
  }
  return state;
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
  it.each([null, 'c2'])('retries folder creation without advancing to %s', async nextCursor => {
    const directory = new Directory('file:///mirror/sessions/s1');
    const create = vi.spyOn(directory, 'create');
    const h = harness({ mirrorSessionDir: () => directory });
    h.sessions.push({ id: 's1', updatedAt: T1 });
    h.pages.set('s1', { messages: [], nextCursor: 'c1' });
    await syncArtifactMirror({ deps: h.deps });

    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    h.pages.set('s1', { messages: [messageOf(['f1'])], nextCursor });
    create.mockImplementationOnce(() => {
      throw new Error('temporary filesystem failure');
    });
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(h.downloadFile).not.toHaveBeenCalled();
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);

    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 1,
    });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(3);
    expect(h.getSessionMessagesPage).toHaveBeenLastCalledWith({ session_id: 's1', cursor: 'c1' });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps a missing browsable container a successful no-op', async () => {
    const h = harness({ mirrorSessionDir: () => null });
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 0,
    });
    await syncArtifactMirror({ force: true, deps: h.deps });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(1);
    expect(h.downloadFile).not.toHaveBeenCalled();
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);
  });

  it('keeps the previous mirror when a download fails and retries it next run', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    await syncArtifactMirror({ deps: h.deps });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);

    // The session changed: the page is re-read from the top, the already
    // materialized file is skipped, and the second download fails.
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` },
    ]);
    h.downloads.set(`${STORAGE_ORIGIN}/f2`, async () => {
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
    expect(h.downloadFile).toHaveBeenCalledWith(`${STORAGE_ORIGIN}/f2`, expect.anything());

    // The retry: the held cursor re-reads the same page and f2 lands.
    h.downloads.set(`${STORAGE_ORIGIN}/f2`, async () => downloaded(10));
    h.setNow(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1').toSorted()).toEqual(['f1', 'f2']);
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(3);
  });

  it('does not re-fetch a session whose crawl is done', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    await syncArtifactMirror({ deps: h.deps });
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(1);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
  });

  it('re-reads a session whose mirrored bytes are gone and keeps the ones left', async () => {
    // The mirror is derived data: the file browser or the OS can remove it.
    // Stored crawl state that still names the file would skip re-materializing
    // it and publish it in the index anyway, so the run checks the disk first.
    // The session's surviving files stay indexed and are not fetched again.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 20, url: `${STORAGE_ORIGIN}/f2` },
    ]);

    await syncArtifactMirror({ deps: h.deps });
    expect(h.downloadFile).toHaveBeenCalledTimes(2);
    fakeFs.remove('file:///mirror/sessions/f1');
    // Only the first run announced the tree so far.
    expect(h.notify).toHaveBeenCalledOnce();

    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(
      h.downloadFile.mock.calls.filter(([url]) => url === `${STORAGE_ORIGIN}/f2`)
    ).toHaveLength(1);
    expect(sessionFiles(h.lastManifest(), 's1').toSorted()).toEqual(['f1', 'f2']);
    // The re-materialized file may land in a different index position, which is
    // itself a change; either way the provider is told, because the run wrote
    // bytes and the browser has to re-read them.
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('notifies when a repair rewrites a file without changing the index', async () => {
    // The reconcile drops a file whose bytes the device removed, and the crawl
    // materializes it again. When the lost file is the last one in the session,
    // restoring it appends to the same position the index already holds, so the
    // published content is byte-identical while the file behind it is new. The
    // provider still has to be told, which the content comparison alone misses.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 20, url: `${STORAGE_ORIGIN}/f2` },
    ]);

    await syncArtifactMirror({ deps: h.deps });
    const beforeRepair = h.lastManifest();
    expect(h.notify).toHaveBeenCalledOnce();

    fakeFs.remove('file:///mirror/sessions/f2');
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });

    // Same index, new bytes: only the new condition announces it.
    expect(h.lastManifest()).toEqual(beforeRepair);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('keeps reconciling the other sessions when one cannot be inspected', async () => {
    // The probe reads the filesystem, so one folder can refuse it. That session
    // keeps its stored state; every other session is still checked.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 }, { id: 's2', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    setFiles(h, 's2', [{ id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` }]);

    await syncArtifactMirror({ deps: h.deps });
    fakeFs.remove('file:///mirror/sessions/f1');
    h.deps.mirrorSessionDir = (sessionId: string) => {
      if (sessionId === 's2') {
        throw new Error('the folder could not be read');
      }
      return new Directory('file:///mirror/sessions');
    };

    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    const outcome = await syncArtifactMirror({ deps: h.deps });

    expect(outcome).toMatchObject({ status: 'synced' });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(3);
    expect(h.downloadFile).toHaveBeenCalledTimes(3);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(sessionFiles(h.lastManifest(), 's2')).toEqual(['f2']);
  });

  it('restarts a session whose head changed while its crawl was in progress', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    registerDownloads(h, [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` },
      { id: 'f3', size: 10, url: `${STORAGE_ORIGIN}/f3` },
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
    expect(
      h.downloadFile.mock.calls.filter(([url]) => url === `${STORAGE_ORIGIN}/f1`)
    ).toHaveLength(1);
  });

  it('does not record a retryable failed page as a finished crawl and retries it next run', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    registerDownloads(h, [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    let failure: string | null = 'retryable_failure';
    const getSessionMessagesPage = vi.fn(async () =>
      failure === null
        ? { history: { messages: [messageOf(['f1'])], nextCursor: null } }
        : { history: { kind: failure } }
    );
    h.deps.getSessionMessagesPage = getSessionMessagesPage;

    // A retryable failure is not proof that a session has no artifacts: the
    // crawl holds the page so the next run reads it again.
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(sessionIds(h.lastManifest())).toEqual(['s1']);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);

    // The page arrives at last: the held cursor re-reads it and f1 lands.
    failure = null;
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(getSessionMessagesPage).toHaveBeenCalledTimes(2);
  });

  it('records a terminal failed page as crawled so it stops spending an advance slot', async () => {
    const h = harness();
    h.sessions.push({ id: 'terminal', updatedAt: T1 }, { id: 's2', updatedAt: T1 });
    registerDownloads(h, [{ id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` }]);
    const getSessionMessagesPage = vi.fn(async (input: { session_id: string }) =>
      input.session_id === 'terminal'
        ? { history: { kind: 'invalid_data' } }
        : { history: { messages: [messageOf(['f2'])], nextCursor: null } }
    );
    h.deps.getSessionMessagesPage = getSessionMessagesPage;

    // Run one reads both pages: the unpageable session is recorded as crawled
    // with no files, and the session behind it still advances.
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 'terminal')).toEqual([]);
    expect(sessionFiles(h.lastManifest(), 's2')).toEqual(['f2']);
    expect(getSessionMessagesPage).toHaveBeenCalledTimes(2);

    // Run two does not re-spend a slot on the terminal session.
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 0,
      files: 0,
    });
    expect(getSessionMessagesPage).toHaveBeenCalledTimes(2);
  });

  it('does not persist an artifact URL, including a data: payload, in the crawl state', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 3, url: 'data:text/plain;base64,QUJD' },
    ]);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 2,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1', 'f2']);

    // The persisted crawl state holds only what the manifest rebuild reads; the
    // URL is dead weight, and a data: URL is the whole payload.
    const persisted = [...h.store.values()].join('\n');
    expect(persisted).not.toContain('"url"');
    expect(persisted).not.toContain('base64');
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
        { id: `${session.id}-f1`, size: 10, url: `${STORAGE_ORIGIN}/${session.id}` },
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
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    setFiles(h, 's2', [{ id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` }]);

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
        url: `${STORAGE_ORIGIN}/n${index}`,
      }))
    );
    setFiles(h, 'older', [{ id: 'o1', size: perFile, url: `${STORAGE_ORIGIN}/o1` }]);

    await syncArtifactMirror({ deps: h.deps });

    const manifest = h.lastManifest();
    expect(sessionIds(manifest)).toEqual(['newer', 'older']);
    expect(sessionFiles(manifest, 'newer')).toHaveLength(10);
    expect(sessionFiles(manifest, 'older')).toEqual([]);
  });

  it('discards a run that resolves after a sign-out and writes nothing', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
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
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
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

  it('keeps the bytes a later generation wrote when a stale download finishes', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    // The old generation parks inside its download, so the newer generation can
    // finish the same artifact first.
    const releaseOld = vi.fn<() => void>();
    const oldDownload = new Promise<void>(resolve => {
      releaseOld.mockImplementation(resolve);
    });
    const markEntered = vi.fn<() => void>();
    const enteredDownload = new Promise<void>(resolve => {
      markEntered.mockImplementation(resolve);
    });
    const canonical = 'file:///mirror/sessions/f1';
    let firstDownload = true;
    h.deps.downloadFile = vi.fn(async (_url: string) => {
      if (firstDownload) {
        firstDownload = false;
        markEntered();
        await oldDownload;
      }
      return downloaded(10);
    });

    const oldRun = syncArtifactMirror({ force: true, deps: h.deps });
    // Wait until the old generation is provably inside its download, so the
    // sign-out below lands after the fence that gated starting it.
    await enteredDownload;

    // Sign out and back in while the old download is still parked: the epoch it
    // captured is stale, and teardown has dropped the single-flight memo, so the
    // next run is a new generation writing the same canonical path.
    setSignOutActive(true);
    bumpAuthEpoch();
    setSignOutActive(false);
    resetArtifactMirrorSyncState();

    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 1,
    });
    expect(fakeFs.deleted(canonical)).toBe(false);

    releaseOld();
    expect(await oldRun).toEqual({ status: 'discarded' });

    // The stale run may only remove bytes it wrote itself: the file the newer
    // generation published is still on disk and still in its manifest.
    expect(fakeFs.deleted(canonical)).toBe(false);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
  });

  it('does not signal the provider when a sign-out lands inside the state write', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    h.deps.writeState = vi.fn(async () => {
      setSignOutActive(true);
    });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'discarded' });
    // The teardown clears the mirror, so the run stops before telling an open
    // browser to re-query a location that no longer holds anything.
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('syncArtifactMirror terminal outcomes', () => {
  const SANDBOX_URL =
    'file:///tmp/attachments/s1/user-1/2f5f0f4e-1f1a-4f0b-9d4f-3b1e5c7a9d21/shot.png';

  it('records a permanently missing artifact so the cursor advances and it is never fetched again', async () => {
    // The tRPC client carries the server's code on `data.code`; NOT_FOUND is the
    // backend saying the attachment is gone, the same fact a 404 reports.
    const presignAttachmentDownload = vi.fn(async () => {
      throw Object.assign(new Error('the attachment is gone'), {
        data: { code: 'NOT_FOUND' },
      });
    });
    const h = harness({ presignAttachmentDownload });
    h.sessions.push({ id: 's1', updatedAt: T1 });
    h.pages.set('s1', {
      messages: [
        {
          parts: [
            { id: 'f1', mime: 'image/png', type: 'file', url: SANDBOX_URL },
            { id: 'f2', mime: 'text/plain', type: 'file', url: `${STORAGE_ORIGIN}/f2` },
          ],
        },
      ],
      nextCursor: null,
    });
    registerDownloads(h, [{ id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` }]);

    // Run one: f1 cannot be materialized ever, f2 lands, and the page is
    // finished rather than held for a retry that can never succeed.
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f2']);
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    const state = storedSession(h.store, 's1');
    expect(state.terminal).toEqual({ f1: 'missing' });
    expect(JSON.stringify(state)).not.toContain('"url"');

    // Run two: the session is done, so it is not even re-read, and f1 is never
    // probed or downloaded again.
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 0,
    });
    expect(
      h.getSessionMessagesPage.mock.calls.filter(([input]) => input.session_id === 's1')
    ).toHaveLength(1);
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    expect(presignAttachmentDownload).toHaveBeenCalledTimes(1);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f2']);
  });

  it('probes an over-cap artifact once and never again, even after the session restarts', async () => {
    const probeContentLength = vi.fn(async () => MAX_ARTIFACT_BYTES + 1);
    const h = harness({ probeContentLength });
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(probeContentLength).toHaveBeenCalledTimes(1);
    expect(h.downloadFile).not.toHaveBeenCalled();
    expect(storedSession(h.store, 's1').terminal).toEqual({ f1: 'too-large' });

    // The session changes: the crawl restarts from page one. The size is a fact
    // about the artifact, not about the revision, so it is not re-probed.
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 0,
    });
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(probeContentLength).toHaveBeenCalledTimes(1);
    expect(h.downloadFile).not.toHaveBeenCalled();
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);
    expect(storedSession(h.store, 's1').terminal).toEqual({ f1: 'too-large' });
  });

  it('holds the cursor for a temporary failure until the attempt budget is spent, then advances', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    h.pages.set('s1', { messages: [messageOf(['f3'])], nextCursor: null });
    h.downloads.set(`${STORAGE_ORIGIN}/f3`, async () => {
      throw new Error('offline');
    });

    // Every attempt before the last one leaves the cursor where it was, so the
    // same page is re-read and the same artifact retried.
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    expect(storedSession(h.store, 's1')).toMatchObject({ cursor: null, done: false });
    expect(storedSession(h.store, 's1')).toMatchObject({ attempts: { f3: 1 }, terminal: {} });

    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(h.downloadFile).toHaveBeenCalledTimes(2);
    expect(storedSession(h.store, 's1')).toMatchObject({ cursor: null, done: false });
    expect(storedSession(h.store, 's1')).toMatchObject({ attempts: { f3: 2 }, terminal: {} });

    // The last attempt spends the budget: the artifact is written off for this
    // revision and the page finishes instead of starving the sessions behind it.
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      failed: 1,
      files: 0,
    });
    expect(h.downloadFile).toHaveBeenCalledTimes(MAX_ARTIFACT_ATTEMPTS);
    expect(storedSession(h.store, 's1')).toMatchObject({ cursor: null, done: true });
    expect(storedSession(h.store, 's1').terminal).toEqual({ f3: 'attempts-exhausted' });

    // The written-off artifact is not attempted a fourth time.
    expect(await syncArtifactMirror({ force: true, deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 0,
    });
    expect(h.downloadFile).toHaveBeenCalledTimes(MAX_ARTIFACT_ATTEMPTS);
    expect(h.getSessionMessagesPage).toHaveBeenCalledTimes(MAX_ARTIFACT_ATTEMPTS);
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual([]);
  });

  it('gives the run budget to the sessions that waited longest', async () => {
    const h = harness();
    h.sessions.push(
      { id: 's1', updatedAt: T1 },
      { id: 's2', updatedAt: T1 },
      { id: 's3', updatedAt: T1 },
      { id: 's4', updatedAt: T1 }
    );
    for (const session of h.sessions) {
      setFiles(h, session.id, [
        { id: `${session.id}-f1`, size: 10, url: `${STORAGE_ORIGIN}/${session.id}-f1` },
      ]);
    }
    // s1 keeps failing temporarily, so it stays a candidate forever and would
    // hold the first slot on every run if the walk were in list order.
    h.downloads.set(`${STORAGE_ORIGIN}/s1-f1`, async () => {
      throw new Error('offline');
    });

    const advancedPerRun: string[][] = [];
    const forceRun = async (index: number): Promise<void> => {
      const before = h.getSessionMessagesPage.mock.calls.length;
      h.setNow(NOW + index * MIRROR_SYNC_MIN_INTERVAL_MS);
      await syncArtifactMirror({ force: true, deps: h.deps });
      advancedPerRun.push(
        h.getSessionMessagesPage.mock.calls.slice(before).map(([input]) => input.session_id)
      );
    };

    // Nothing has been advanced yet, so the first run breaks ties by list order.
    await forceRun(0);
    expect(advancedPerRun[0]).toEqual(['s1', 's2', 's3']);
    // s4 waited longest (never advanced), so it goes first this time even
    // though s1 sits at the front of the list and is still a candidate.
    await forceRun(1);
    expect(advancedPerRun[1]).toEqual(['s4', 's1']);
    await forceRun(2);
    expect(advancedPerRun[2]).toEqual(['s1']);

    const manifest = h.lastManifest();
    expect(sessionFiles(manifest, 's2')).toEqual(['s2-f1']);
    expect(sessionFiles(manifest, 's3')).toEqual(['s3-f1']);
    expect(sessionFiles(manifest, 's4')).toEqual(['s4-f1']);
    expect(sessionFiles(manifest, 's1')).toEqual([]);
  });

  it('parses a stored row written before the terminal and attempt fields existed', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    // A row from the previous schema: no `terminal`, `attempts` or
    // `lastAdvancedAt` at all.
    h.store.set(
      SYNC_STATE_KEY,
      JSON.stringify({
        lastRunAt: NOW - MIRROR_SYNC_MIN_INTERVAL_MS,
        sessions: { s1: { cursor: null, done: false, files: [], updatedAt: T1 } },
      })
    );

    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 1,
    });
    expect(sessionFiles(h.lastManifest(), 's1')).toEqual(['f1']);
    expect(storedSession(h.store, 's1')).toMatchObject({
      attempts: {},
      done: true,
      lastAdvancedAt: NOW,
      terminal: {},
      updatedAt: T1,
    });
  });
});

describe('syncArtifactMirror manifest stability', () => {
  it('a run that finds nothing new keeps the manifest bytes and does not notify', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    await syncArtifactMirror({ deps: h.deps });
    const first = h.lastManifest();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.downloadFile).toHaveBeenCalledOnce();

    // The same tree a run later: the snapshot is still applied (it is the
    // idempotent tree writer that prunes stale entries) but it carries the
    // stamp already on disk, so the index bytes are untouched, and nothing is
    // announced because no listing can have changed.
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({ status: 'synced' });

    expect(h.applied).toHaveLength(2);
    expect(h.lastManifest()).toEqual(first);
    expect(h.lastManifest().updatedAt).toBe(first.updatedAt);
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.downloadFile).toHaveBeenCalledOnce();
  });

  it('a run that only repairs the tree notifies while the index stays identical', async () => {
    // A session with no files publishes an empty file list, so re-creating its
    // folder after the platform file browser deleted it changes nothing in the
    // index: `changed` is false and no artifact was materialized. The snapshot's
    // report is the only evidence the tree moved, and an open browser that
    // showed the folder as missing has to re-read.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({
      failed: 0,
      files: 0,
      sessions: 1,
      status: 'synced',
    });
    const first = h.lastManifest();
    expect(h.notify).toHaveBeenCalledOnce();

    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    h.setRepaired(true);
    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({
      failed: 0,
      files: 0,
      sessions: 1,
      status: 'synced',
    });

    expect(h.lastManifest()).toEqual(first);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('a run that adds an artifact restamps and notifies', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);

    await syncArtifactMirror({ deps: h.deps });
    const firstStamp = h.lastManifest().updatedAt;

    // An unchanged run leaves both the stamp and the provider alone.
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });
    expect(h.lastManifest().updatedAt).toBe(firstStamp);
    expect(h.notify).toHaveBeenCalledOnce();

    // The session grows a second artifact, so the tree really changed: that run
    // restamps and announces once.
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` },
    ]);
    h.setNow(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(await syncArtifactMirror({ deps: h.deps })).toMatchObject({
      status: 'synced',
      files: 1,
    });

    expect(sessionFiles(h.lastManifest(), 's1').toSorted()).toEqual(['f1', 'f2']);
    expect(h.lastManifest().updatedAt).toBe(
      new Date(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS).toISOString()
    );
    expect(h.lastManifest().updatedAt).not.toBe(firstStamp);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('a run that prunes a session also notifies', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 }, { id: 's2', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    setFiles(h, 's2', [{ id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` }]);

    await syncArtifactMirror({ deps: h.deps });
    expect(sessionIds(h.lastManifest())).toEqual(['s1', 's2']);

    // A session leaving the list page removes its folder from the tree, so the
    // run that prunes it restamps and announces.
    h.sessions.length = 1;
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });
    expect(sessionIds(h.lastManifest())).toEqual(['s1']);
    expect(h.notify).toHaveBeenCalledTimes(2);
    const pruned = h.lastManifest();

    // The run after the prune sees the pruned index on disk and is quiet again.
    h.setNow(NOW + 2 * MIRROR_SYNC_MIN_INTERVAL_MS);
    await syncArtifactMirror({ deps: h.deps });
    expect(sessionIds(h.lastManifest())).toEqual(['s1']);
    expect(h.lastManifest().updatedAt).toBe(pruned.updatedAt);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });
});

describe('syncArtifactMirror failed runs', () => {
  /** The persisted crawl state, parsed: the part a failed run must not advance. */
  function storedState(store: Map<string, string>): {
    lastRunAt: number | null;
    sessions: Record<string, unknown>;
  } {
    const raw = store.get(`cache:${USER_ID}:2/artifact-mirror:${USER_ID}`);
    if (raw === undefined) {
      throw new Error('no sync state was written');
    }
    return JSON.parse(raw) as { lastRunAt: number | null; sessions: Record<string, unknown> };
  }

  it('a failed run records the attempt so the next trigger is gated', async () => {
    // A run that throws used to leave `lastRunAt` untouched, so the next
    // foreground refresh or remount started another full crawl at once against
    // the condition that had just failed.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    const failing = vi.fn(async () => {
      throw new Error('the session list is unreachable');
    });
    h.deps.listSessions = failing;

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'failed' });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(storedState(h.store).lastRunAt).toBe(NOW);

    // The next trigger is inside the interval, so the gate answers before any
    // list request is made.
    const working = vi.fn(async () => ({ cliSessions: [], nextCursor: null }));
    h.deps.listSessions = working;
    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({
      status: 'skipped',
      reason: 'interval',
    });
    expect(working).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('a failed run does not persist the partial crawl state', async () => {
    // The run can advance a session's cursor and file list in memory before a
    // later step throws. None of that reached the mirror, so persisting it
    // would record a cursor that hides the page it never finished and files
    // whose bytes may not be on disk.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` }]);
    await syncArtifactMirror({ deps: h.deps });
    const before = storedState(h.store);
    expect(Object.keys(before.sessions)).toEqual(['s1']);

    // A new page advances the crawl state, then the publication throws, so the
    // run fails after `advanceSessions` already wrote into `run.states`.
    h.sessions[0] = { id: 's1', updatedAt: T2 };
    setFiles(h, 's1', [
      { id: 'f1', size: 10, url: `${STORAGE_ORIGIN}/f1` },
      { id: 'f2', size: 10, url: `${STORAGE_ORIGIN}/f2` },
    ]);
    h.setNow(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    h.deps.applySnapshot = () => {
      throw new Error('the mirror refused the snapshot');
    };

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'failed' });
    const after = storedState(h.store);
    // The attempt is stamped, but the crawl state is the one from before it.
    expect(after.lastRunAt).toBe(NOW + MIRROR_SYNC_MIN_INTERVAL_MS);
    expect(after.sessions).toEqual(before.sessions);
  });

  it('a failed run writes no state after a sign-out', async () => {
    // The fence exists to stop a run that resolves after teardown from
    // repopulating what sign-out just cleared, and the attempt stamp is a write
    // like any other.
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    h.deps.listSessions = vi.fn(async () => {
      throw new Error('the session list is unreachable');
    });

    // Still signed in, the same failure does record the attempt, so the check
    // below is about the fence and not about the stamp being missing.
    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'failed' });
    expect(storedState(h.store).lastRunAt).toBe(NOW);

    h.store.clear();
    setSignOutActive(false);
    resetArtifactMirrorSyncState();
    h.deps.listSessions = vi.fn(async () => {
      setSignOutActive(true);
      throw new Error('the session list failed after sign-out');
    });

    expect(await syncArtifactMirror({ deps: h.deps })).toEqual({ status: 'failed' });
    expect(h.store.size).toBe(0);
  });
});
