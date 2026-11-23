/* eslint-disable max-lines -- one suite covers the file-system and durable-draft mocks together. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharePayloadStoreForTests,
  putSharePayload,
  restoreSharePayload,
  setSharePersistUserId,
  SHARE_PAYLOAD_MAX_ENTRIES,
} from './share-payload';
import {
  __resetPendingShareNavigationForTests,
  appendShareParams,
  clearAccountStagedShareNavigation,
  isShareNavigationTargetFocused,
  navigationContainsShareGate,
  parseShareHrefParams,
  persistShareNavigationNow,
  restoreShareNavigation,
  setPendingShareNavigation,
  shareDeliveryShareId,
  takePendingShareNavigation,
} from './share-navigation';
import { flushDraft, saveDraft, SHARE_NAV_DRAFT_KEY } from '@/lib/persist/drafts';

// share-navigation imports SHARE_PAYLOAD_MAX_ENTRIES from share-payload, which
// pulls expo modules that transitively load react-native Flow sources.
vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `id-test-${n}`;
    },
  };
});
const expoFileSystemMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const File = vi.fn(function FileMock(_base: unknown, ...rest: unknown[]) {
    const uri =
      rest.length > 0 ? `${(_base as { uri: string }).uri}/${String(rest[0])}` : String(_base);
    return {
      uri,
      get exists() {
        return files.has(uri);
      },
      write(content: string) {
        files.set(uri, content);
      },
      textSync() {
        return files.get(uri) ?? '';
      },
      delete() {
        files.delete(uri);
      },
    };
  });
  return {
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

// The drafts module (lazy-required by share-navigation) imports the native
// encrypted-kv chain; the fake mirrors its upsert semantics.
const kvStore = vi.hoisted(
  () => new Map<string, { scope: string; k: string; v: string; updatedAt: number }>()
);
const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

let nextUpdatedAt = 1;

afterEach(() => {
  __resetPendingShareNavigationForTests();
});

describe('share-navigation', () => {
  it('set then take returns the entry', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=a',
      shareId: 'a',
    });
  });

  it('second take returns null', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    takePendingShareNavigation();
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('enqueues FIFO: take returns oldest first', () => {
    setPendingShareNavigation({ href: '/first', shareId: 'first' });
    setPendingShareNavigation({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toEqual({ href: '/first', shareId: 'first' });
    expect(takePendingShareNavigation()).toEqual({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('drops oldest when enqueue would exceed SHARE_PAYLOAD_MAX_ENTRIES', () => {
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 2; i += 1) {
      setPendingShareNavigation({ href: `/${i}`, shareId: `id-${i}` });
    }
    const taken: string[] = [];
    let next = takePendingShareNavigation();
    while (next) {
      if (shareDeliveryShareId(next)) {
        taken.push(next.shareId);
      }
      next = takePendingShareNavigation();
    }
    expect(taken).toHaveLength(SHARE_PAYLOAD_MAX_ENTRIES);
    expect(taken.at(0)).toBe('id-2');
    expect(taken.at(-1)).toBe(`id-${SHARE_PAYLOAD_MAX_ENTRIES + 1}`);
  });

  it('take with nothing pending returns null', () => {
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('reset clears the full queue', () => {
    setPendingShareNavigation({ href: '/a', shareId: 'a' });
    setPendingShareNavigation({ href: '/b', shareId: 'b' });
    __resetPendingShareNavigationForTests();
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('enqueues and returns a null-shareId navigation unchanged', () => {
    setPendingShareNavigation({
      href: '/(app)/pr-review/octocat/hello-world/42',
      shareId: null,
    });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/pr-review/octocat/hello-world/42',
      shareId: null,
    });
  });
});

describe('share navigation durable persistence', () => {
  beforeEach(() => {
    __resetPendingShareNavigationForTests();
    vi.clearAllMocks();
    kvStore.clear();
    nextUpdatedAt = 1;
    kvMock.getItem.mockImplementation(
      async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
    );
    kvMock.setItem.mockImplementation(async (scope, k, v) => {
      kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
      nextUpdatedAt += 1;
    });
    kvMock.removeItem.mockImplementation(async (scope, k) => {
      kvStore.delete(storageKey(scope, k));
    });
    kvMock.listEntries.mockImplementation(async scope =>
      [...kvStore.values()]
        .filter(entry => entry.scope === scope)
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
    );
  });

  beforeEach(() => {
    __resetSharePayloadStoreForTests();
  });

  afterEach(() => {
    __resetPendingShareNavigationForTests();
    setSharePersistUserId(null);
    __resetSharePayloadStoreForTests();
  });

  // A delivery always names a staged payload: the cold start restores the
  // payloads first, then the queue. Queue cases therefore stage the payload
  // their destination names.
  function stageDestination(text: string): string {
    const shareId = putSharePayload({ text, files: [], failedFiles: [] });
    setPendingShareNavigation({ href: `/(app)/agent-chat/new?shareId=${shareId}`, shareId });
    return shareId;
  }

  it('set then restore returns the same href and shareId', async () => {
    setSharePersistUserId('u1');
    const shareId = stageDestination('a');
    await persistShareNavigationNow();
    __resetPendingShareNavigationForTests();
    // simulate process death (clears memory)
    await restoreShareNavigation('u1');
    expect(takePendingShareNavigation()).toEqual({
      href: `/(app)/agent-chat/new?shareId=${shareId}`,
      shareId,
    });
  });

  it('take then restore returns null', async () => {
    setSharePersistUserId('u1');
    setPendingShareNavigation({ href: '/(app)/agent-chat/ses_1?shareId=b', shareId: 'b' });
    await persistShareNavigationNow();
    const taken = takePendingShareNavigation();
    expect(taken).toEqual({ href: '/(app)/agent-chat/ses_1?shareId=b', shareId: 'b' });
    await persistShareNavigationNow();
    __resetPendingShareNavigationForTests();
    await restoreShareNavigation('u1');
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('restore does not replace a non-empty in-memory queue', async () => {
    setSharePersistUserId('u1');
    // Persist a draft that differs from the live queue.
    setPendingShareNavigation({ href: '/(app)/agent-chat/o', shareId: 'o' });
    await persistShareNavigationNow();
    __resetPendingShareNavigationForTests();

    // A navigation committed in this process.
    setPendingShareNavigation({ href: '/(app)/agent-chat/live', shareId: 'live' });

    await restoreShareNavigation('u1');

    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/live',
      shareId: 'live',
    });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('persists no destination staged before an account resolved', async () => {
    // A destination captured with no account resolved stays in memory (DEC-01).
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=out', shareId: 'out' });

    setSharePersistUserId('u1');
    await persistShareNavigationNow();

    __resetPendingShareNavigationForTests();
    await restoreShareNavigation('u1');
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('persists only the account destination when a signed-out one shares the queue', async () => {
    stageDestination('captured-out');
    setSharePersistUserId('u1');
    const owned = stageDestination('by-u1');
    await persistShareNavigationNow();

    __resetPendingShareNavigationForTests();
    await restoreShareNavigation('u1');

    expect(takePendingShareNavigation()).toEqual({
      href: `/(app)/agent-chat/new?shareId=${owned}`,
      shareId: owned,
    });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('resumes the account draft beside a destination staged before an account resolved', async () => {
    setSharePersistUserId('userA');
    const owned = stageDestination('staged-by-a');
    await persistShareNavigationNow();

    // Sign-out: the account boundary drops its destination, draft stays.
    clearAccountStagedShareNavigation();
    setSharePersistUserId(null);
    const stagedOut = stageDestination('captured-out');

    // Same-process sign-in as A: the cold start restores the payloads first, so
    // A's staged payload is in the store when the queue merges its draft.
    setSharePersistUserId('userA');
    putSharePayload({ text: 'staged-by-a', files: [], failedFiles: [] });
    await restoreShareNavigation('userA');

    // The capture keeps its place; taking it must never drop A's destination.
    expect(takePendingShareNavigation()).toEqual({
      href: `/(app)/agent-chat/new?shareId=${stagedOut}`,
      shareId: stagedOut,
    });
    expect(takePendingShareNavigation()).toEqual({
      href: `/(app)/agent-chat/new?shareId=${owned}`,
      shareId: owned,
    });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('restores nothing when the queue already holds the cap', async () => {
    // The queue is full of destinations this process staged, so the account's
    // retained destinations have no room and the cap must hold.
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES; i += 1) {
      stageDestination(`live-${i}`);
    }
    saveDraft('userA', SHARE_NAV_DRAFT_KEY, [
      { href: '/(app)/pr-review/acme/repo/1', shareId: null },
      { href: '/(app)/pr-review/acme/repo/2', shareId: null },
    ]);
    await flushDraft('userA', SHARE_NAV_DRAFT_KEY);

    setSharePersistUserId('userA');
    await restoreShareNavigation('userA');

    const queued: (string | null)[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 1; i += 1) {
      const next = takePendingShareNavigation();
      if (next === null) {
        break;
      }
      queued.push(next.shareId);
    }
    // Only the live destinations remain: the cap held and nothing was dropped.
    expect(queued).toHaveLength(SHARE_PAYLOAD_MAX_ENTRIES);
    expect(queued.every(shareId => shareId !== null)).toBe(true);
  });

  it('does not restore a destination whose payload was not restored', async () => {
    // The payload restore stops at the cap, so a destination past that room has
    // nothing to deliver. It must not queue, or delivery would clear the share
    // id into an empty composer.
    saveDraft('userA', SHARE_NAV_DRAFT_KEY, [
      { href: '/(app)/agent-chat/new?shareId=kept', shareId: 'kept' },
      { href: '/(app)/agent-chat/new?shareId=skipped', shareId: 'skipped' },
      { href: '/(app)/pr-review/acme/repo/42', shareId: null },
    ]);
    await flushDraft('userA', SHARE_NAV_DRAFT_KEY);

    setSharePersistUserId('userA');
    restoreSharePayload('kept', { text: 'kept', files: [], failedFiles: [] }, 'userA');
    await restoreShareNavigation('userA');

    // The payload-bearing destination whose payload exists queues, the one whose
    // payload the restore skipped does not, and the payload-free route does.
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=kept',
      shareId: 'kept',
    });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/pr-review/acme/repo/42',
      shareId: null,
    });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('keeps a live destination when the account draft alone fills the cap', async () => {
    // A full account draft, left by that account's previous session.
    const ownedIds = Array.from({ length: SHARE_PAYLOAD_MAX_ENTRIES }, (_, i) => `owned-${i}`);
    saveDraft(
      'userA',
      SHARE_NAV_DRAFT_KEY,
      ownedIds.map(id => ({ href: `/(app)/agent-chat/new?shareId=${id}`, shareId: id }))
    );
    await flushDraft('userA', SHARE_NAV_DRAFT_KEY);

    // That account's staged payloads come back first, then one capture staged
    // before the account resolved waits behind them.
    setSharePersistUserId('userA');
    for (const id of ownedIds.slice(0, SHARE_PAYLOAD_MAX_ENTRIES - 1)) {
      restoreSharePayload(id, { text: id, files: [], failedFiles: [] }, 'userA');
    }
    setSharePersistUserId(null);
    const stagedOut = stageDestination('captured-out');

    setSharePersistUserId('userA');
    await restoreShareNavigation('userA');

    const queued: (string | null)[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 1; i += 1) {
      const next = takePendingShareNavigation();
      if (next === null) {
        break;
      }
      queued.push(next.shareId);
    }
    // The live destination is still deliverable, and the queue holds the cap.
    expect(queued).toContain(stagedOut);
    expect(queued).toContain(ownedIds[0]);
    expect(queued.length).toBe(SHARE_PAYLOAD_MAX_ENTRIES);
  });

  it('restores the hinted destination when the queue has one slot left', async () => {
    // The account committed the destination the hint names, then a newer
    // composer delivery.
    setSharePersistUserId('u1');
    const hinted = stageDestination('hinted');
    const newer = stageDestination('newer');
    await persistShareNavigationNow();

    // Process death; the destinations staged before the account resolved come
    // back first and leave a single free slot.
    __resetPendingShareNavigationForTests();
    __resetSharePayloadStoreForTests();
    setSharePersistUserId(null);
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES - 1; i += 1) {
      setPendingShareNavigation({ href: `/(app)/agent-chat/live-${i}`, shareId: null });
    }

    // The payload restore brings both staged payloads back, so both retained
    // destinations are deliverable when the queue merges its draft.
    setSharePersistUserId('u1');
    restoreSharePayload(hinted, { text: 'hinted', files: [], failedFiles: [] }, 'u1');
    restoreSharePayload(newer, { text: 'newer', files: [], failedFiles: [] }, 'u1');
    await restoreShareNavigation('u1', hinted);

    const queued: (string | null)[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 1; i += 1) {
      const next = takePendingShareNavigation();
      if (next === null) {
        break;
      }
      queued.push(next.shareId);
    }
    // The hinted delivery survives because the gate can only re-open on it, the
    // newer one is the destination that did not fit, and the cap holds.
    expect(queued).toContain(hinted);
    expect(queued).not.toContain(newer);
    expect(queued.length).toBeLessThanOrEqual(SHARE_PAYLOAD_MAX_ENTRIES);
  });

  it('stops restoring when the account changes during the read', async () => {
    setSharePersistUserId('userA');
    saveDraft('userA', SHARE_NAV_DRAFT_KEY, [
      { href: '/(app)/agent-chat/ses_a?shareId=a&organizationId=org_a', shareId: 'a' },
    ]);
    await flushDraft('userA', SHARE_NAV_DRAFT_KEY);

    const restore = restoreShareNavigation('userA');
    clearAccountStagedShareNavigation();
    setSharePersistUserId('userB');
    await restore;

    expect(takePendingShareNavigation()).toBeNull();
  });
});

describe('share navigation account boundary', () => {
  beforeEach(() => {
    __resetPendingShareNavigationForTests();
    setSharePersistUserId(null);
    __resetSharePayloadStoreForTests();
  });

  afterEach(() => {
    __resetPendingShareNavigationForTests();
    setSharePersistUserId(null);
    __resetSharePayloadStoreForTests();
  });

  it('drops a destination staged under an account, with its payload id and organization scope', () => {
    setSharePersistUserId('userA');
    setPendingShareNavigation({
      href: '/(app)/agent-chat/new?shareId=share-a&autoSend=1&organizationId=org_a',
      shareId: 'share-a',
    });

    clearAccountStagedShareNavigation();

    expect(takePendingShareNavigation()).toBeNull();
  });

  it('drops a staged non-share destination too', () => {
    setSharePersistUserId('userA');
    setPendingShareNavigation({ href: '/(app)/pr-review/acme/repo/42', shareId: null });

    clearAccountStagedShareNavigation();

    expect(takePendingShareNavigation()).toBeNull();
  });

  it('keeps a destination staged while signed out so a same-process sign-in still delivers it', () => {
    // A share captured with no account resolved stays in memory only (DEC-01).
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=out', shareId: 'out' });

    clearAccountStagedShareNavigation();

    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=out',
      shareId: 'out',
    });
  });

  it('keeps the signed-out destination and drops the account one in the same queue', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=out', shareId: 'out' });
    setSharePersistUserId('userA');
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });

    clearAccountStagedShareNavigation();

    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=out',
      shareId: 'out',
    });
    expect(takePendingShareNavigation()).toBeNull();
  });
});

describe('shareDeliveryShareId', () => {
  it('is false when shareId is null', () => {
    expect(
      shareDeliveryShareId({ href: '/(app)/pr-review/octocat/hello-world/42', shareId: null })
    ).toBe(false);
  });

  it('is true when shareId is a string', () => {
    expect(shareDeliveryShareId({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' })).toBe(
      true
    );
  });
});

describe('parseShareHrefParams', () => {
  it('extracts organizationId from a full new-session href', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new?shareId=abc&organizationId=org_1')).toEqual({
      organizationId: 'org_1',
    });
  });

  it('returns undefined organizationId when absent', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new?shareId=abc')).toEqual({
      organizationId: undefined,
    });
  });

  it('returns undefined organizationId when query is absent', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new')).toEqual({
      organizationId: undefined,
    });
  });

  it('extracts organizationId from an existing-session href the same way', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/ses_1?shareId=x&organizationId=org_2')).toEqual({
      organizationId: 'org_2',
    });
  });
});

describe('isShareNavigationTargetFocused', () => {
  it('matches same-session focused via concrete pathname', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_1')
    ).toBe(true);
  });

  it('is false when the session id differs', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_2')
    ).toBe(false);
  });

  it('matches focused agent-chat/new', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/agent-chat/new')
    ).toBe(true);
  });

  it('is false when on a different screen', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/')).toBe(false);
  });

  it('ignores query string on the href', () => {
    expect(
      isShareNavigationTargetFocused(
        '/(app)/agent-chat/ses_1?shareId=stale&organizationId=o',
        '/agent-chat/ses_1'
      )
    ).toBe(true);
  });

  it('ignores group segments in the href', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/ses_1', '/agent-chat/ses_1')).toBe(
      true
    );
  });

  it('is unaffected by a stale shareId already on the current URL path comparison', () => {
    // Pathname from usePathname has no query; predicate must not consult params.
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=new', '/agent-chat/ses_1')
    ).toBe(true);
  });
});

describe('navigationContainsShareGate', () => {
  it('finds share-gate nested in routes', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: 'share-gate' }] } }],
      })
    ).toBe(true);
  });

  it('is false when the gate is absent', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: '(tabs)' }] } }],
      })
    ).toBe(false);
  });
});

describe('appendShareParams', () => {
  it('appends shareId to a path with no existing query', () => {
    expect(appendShareParams('/(app)/agent-chat/new', 'abc123')).toBe(
      '/(app)/agent-chat/new?shareId=abc123'
    );
  });

  it('appends shareId to a path with an existing query', () => {
    expect(appendShareParams('/(app)/agent-chat/new?organizationId=org_1', 'abc123')).toBe(
      '/(app)/agent-chat/new?organizationId=org_1&shareId=abc123'
    );
  });

  it('appends autoSend=1 when autoSend is true', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { autoSend: true })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123&autoSend=1'
    );
  });

  it('does not append autoSend when autoSend is false', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { autoSend: false })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123'
    );
  });

  it('appends the spawn mode so the destination seeds it', () => {
    expect(
      appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { autoSend: true, mode: 'reviewer' })
    ).toBe('/(app)/agent-chat/ses_1?shareId=abc123&autoSend=1&mode=reviewer');
  });

  it('does not append mode when it is empty or omitted', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { mode: '' })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123'
    );
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123')).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123'
    );
  });

  it('URL-encodes the mode', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { mode: 'my agent' })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123&mode=my%20agent'
    );
  });

  it('URL-encodes the shareId', () => {
    const encoded = appendShareParams('/(app)/agent-chat/new', 'id with spaces');
    expect(encoded).toBe('/(app)/agent-chat/new?shareId=id%20with%20spaces');
  });
});
