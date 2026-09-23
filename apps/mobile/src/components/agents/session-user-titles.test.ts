/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session-user-titles module lazy-loads the native encrypted-kv chain; the
// fake below is an in-memory Map-backed KV so persistence tests run in node.
const kvStore = new Map<string, string>();

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  clearScope: vi.fn(async (_scope: string): Promise<void> => undefined),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

/* eslint-disable import/first */
import { USER_SESSION_TITLES_KEY } from '@/lib/storage-keys';
import { namedSessionTitle } from './session-detail-rename-state';
import {
  __flushUserSessionTitlesWritesForTests,
  __hydrateUserSessionTitlesForTests,
  __peekUserSessionTitleForTests,
  __resetUserSessionTitlesForTests,
  clearUserSessionTitles,
  getRevisionSnapshot,
  getUserSessionTitle,
  rememberUserSessionTitle,
  subscribe,
} from './session-user-titles';
/* eslint-enable import/first */

// Matches the module's internal item key for the single entries blob.
const TITLES_ENTRY_KEY = 'entries';

const PLACEHOLDER = 'New session - 2026-09-22T02:05:22.778Z';

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

function storedBlobEntries(): { sessionId: string; title: string }[] {
  const raw = kvStore.get(storageKey(USER_SESSION_TITLES_KEY, TITLES_ENTRY_KEY));
  return raw ? (JSON.parse(raw) as { sessionId: string; title: string }[]) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  __resetUserSessionTitlesForTests();
  kvMock.getItem.mockImplementation(async (scope, k) => kvStore.get(storageKey(scope, k)) ?? null);
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), v);
  });
  kvMock.clearScope.mockImplementation(async scope => {
    for (const key of kvStore.keys()) {
      if (key.startsWith(`${scope}\u0000`)) {
        kvStore.delete(key);
      }
    }
  });
});

afterEach(async () => {
  await __flushUserSessionTitlesWritesForTests();
});

describe('session-user-titles durable record', () => {
  it('persists a remembered title and restores it on a simulated restart', async () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    await __flushUserSessionTitlesWritesForTests();

    expect(storedBlobEntries()).toEqual([{ sessionId: 'ses-renamed', title: PLACEHOLDER }]);

    // Simulate a cold relaunch: drop the in-memory map and hydrate again.
    __resetUserSessionTitlesForTests();
    expect(getUserSessionTitle('ses-renamed')).toBeUndefined();

    await __hydrateUserSessionTitlesForTests();
    expect(getUserSessionTitle('ses-renamed')).toBe(PLACEHOLDER);
  });

  it('keeps a restored title visible through namedSessionTitle', async () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    await __flushUserSessionTitlesWritesForTests();

    __resetUserSessionTitlesForTests();
    await __hydrateUserSessionTitlesForTests();

    expect(namedSessionTitle(PLACEHOLDER, 'ses-renamed')).toBe(PLACEHOLDER);
    expect(namedSessionTitle(PLACEHOLDER, 'ses-fresh')).toBeUndefined();
  });

  it('notifies subscribers when a hydrated title lands', async () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    await __flushUserSessionTitlesWritesForTests();

    __resetUserSessionTitlesForTests();
    let notified = false;
    const unsubscribe = subscribe(() => {
      notified = true;
    });
    const revisionBefore = getRevisionSnapshot();

    await __hydrateUserSessionTitlesForTests();

    expect(notified).toBe(true);
    expect(getRevisionSnapshot()).toBeGreaterThan(revisionBefore);
    unsubscribe();
  });

  it('does not bump the revision for a title already recorded this run', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    const revision = getRevisionSnapshot();
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    expect(getRevisionSnapshot()).toBe(revision);
  });

  it('ignores a corrupt persisted blob', async () => {
    kvStore.set(storageKey(USER_SESSION_TITLES_KEY, TITLES_ENTRY_KEY), '{not json');
    await __hydrateUserSessionTitlesForTests();
    expect(__peekUserSessionTitleForTests('ses-renamed')).toBeUndefined();
  });

  it('ignores persisted entries that do not match the schema', async () => {
    kvStore.set(
      storageKey(USER_SESSION_TITLES_KEY, TITLES_ENTRY_KEY),
      JSON.stringify([{ sessionId: 'ses-1' }, { title: PLACEHOLDER }])
    );
    await __hydrateUserSessionTitlesForTests();
    expect(__peekUserSessionTitleForTests('ses-1')).toBeUndefined();
  });

  it('lets a remember during the hydration window win over the stale blob', async () => {
    kvStore.set(
      storageKey(USER_SESSION_TITLES_KEY, TITLES_ENTRY_KEY),
      JSON.stringify([
        { sessionId: 'ses-renamed', title: 'New session - 2020-01-01T00:00:00.000Z' },
      ])
    );

    const hydration = __hydrateUserSessionTitlesForTests();
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    await hydration;
    await __flushUserSessionTitlesWritesForTests();

    expect(getUserSessionTitle('ses-renamed')).toBe(PLACEHOLDER);
    expect(storedBlobEntries()).toEqual([{ sessionId: 'ses-renamed', title: PLACEHOLDER }]);
  });

  it('drops memory and storage at an account boundary', async () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    await __flushUserSessionTitlesWritesForTests();
    expect(storedBlobEntries()).toHaveLength(1);

    await clearUserSessionTitles();

    expect(getUserSessionTitle('ses-renamed')).toBeUndefined();
    expect(kvStore.get(storageKey(USER_SESSION_TITLES_KEY, TITLES_ENTRY_KEY))).toBeUndefined();
    expect(kvMock.clearScope).toHaveBeenCalledWith(USER_SESSION_TITLES_KEY);
  });
});
