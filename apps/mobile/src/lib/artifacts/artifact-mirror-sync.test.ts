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
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';

// Real-entry-shaped stand-in for expo-file-system: an entry is a File (the
// mirror sets `size`, promotes with `moveSync` and calls `delete`) and a
// Directory (the sync creates the session folder before materializing into it).
// It tracks paths as well as instances: the fence's job is to not remove a path
// a later generation wrote, so a delete has to be visible at the path, not only
// on the instance that called it.
const fakeFs = vi.hoisted(() => {
  type Tracked = { created: boolean; deleted: boolean; path: string; size: number };
  const entries: Tracked[] = [];
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

    create(): void {
      this.created = true;
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
    }
  }

  return {
    Directory: EntryMock,
    File: EntryMock,
    deleted: (path: string) => deletedPaths.has(path),
    entries,
    reset: () => {
      entries.length = 0;
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
    probeContentLength: vi.fn(async () => null),
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
  it.each([null, 'c2'])('retries folder creation without advancing to %s', async nextCursor => {
    const directory = new Directory('file:///mirror/sessions/s1');
    const create = vi.spyOn(directory, 'create');
    const h = harness({ mirrorSessionDir: () => directory });
    h.sessions.push({ id: 's1', updatedAt: T1 });
    h.pages.set('s1', { messages: [], nextCursor: 'c1' });
    await syncArtifactMirror({ deps: h.deps });

    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);
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
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);

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

  it('does not record a retryable failed page as a finished crawl and retries it next run', async () => {
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
    registerDownloads(h, [{ id: 'f2', size: 10, url: 'https://x/f2' }]);
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
      { id: 'f1', size: 10, url: 'https://x/f1' },
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

  it('keeps the bytes a later generation wrote when a stale download finishes', async () => {
    const h = harness();
    h.sessions.push({ id: 's1', updatedAt: T1 });
    setFiles(h, 's1', [{ id: 'f1', size: 10, url: 'https://x/f1' }]);

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
