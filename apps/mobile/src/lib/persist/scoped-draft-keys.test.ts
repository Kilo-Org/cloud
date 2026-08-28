/* eslint-disable max-lines -- legacy migration cases share the same owner-bound KV fixture */
/* eslint-disable require-await, typescript-eslint/require-await -- fake native methods resolve synchronously */
/* eslint-disable max-params -- the KV fixture mirrors the four-argument guarded write API */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  contextScope,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
} from '@/lib/context-scope';
import { draftScope, isStringDraft, loadDraftResult } from './drafts';
import {
  type DraftTarget,
  listLegacyDraftCandidates,
  migrateLegacyDraft,
  parseScopedDraftKey,
  scopedDraftKey,
} from './scoped-draft-keys';

const mock = vi.hoisted(() => ({
  bytes: new Map<string, string>(),
  set: vi.fn(),
  remove: vi.fn(),
  session: vi.fn(),
}));
const storageKey = (scope: string, key: string) => JSON.stringify([scope, key]);
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, key: string) => mock.bytes.get(storageKey(scope, key)) ?? null,
  setItem: mock.set,
  removeItem: mock.remove,
  listEntries: async (scope: string) =>
    [...mock.bytes.keys()].flatMap((raw, index) => {
      const [storedScope, k] = JSON.parse(raw) as [string, string];
      return storedScope === scope ? [{ k, updatedAt: index }] : [];
    }),
}));
vi.mock('@/lib/trpc', () => ({ trpcClient: { cliSessionsV2: { get: { query: mock.session } } } }));

function signIn(userId = 'oauth/a:用户') {
  bumpAuthEpoch();
  beginAuthenticatedOwner();
  confirmAuthenticatedOwner(getAuthenticatedOwner(), userId);
  return getAuthenticatedOwner();
}
function seed(key: string, value = 'legacy text', userId = 'oauth/a:用户') {
  mock.bytes.set(storageKey(draftScope(userId), key), JSON.stringify(value));
}
function migration(
  candidateKey: string,
  target: DraftTarget,
  organizationId: string | null = null
) {
  const owner = getAuthenticatedOwner();
  return {
    owner,
    candidateKey,
    destinationKey: scopedDraftKey(contextScope(organizationId), target),
    selection: 'explicit' as const,
    isCurrent: () => isAuthenticatedOwner(owner),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.bytes.clear();
  setSignOutActive(false);
  signIn();
  mock.set.mockImplementation(
    async (scope: string, key: string, value: string, guard?: () => boolean) => {
      if (!guard || guard()) {
        mock.bytes.set(storageKey(scope, key), value);
      }
    }
  );
  mock.remove.mockImplementation(async (scope: string, key: string, guard?: () => boolean) => {
    if (!guard || guard()) {
      mock.bytes.delete(storageKey(scope, key));
    }
  });
  mock.session.mockImplementation(async ({ session_id }: { session_id: string }) => ({
    session_id,
    kilo_user_id: 'oauth/a:用户',
    organization_id: null,
  }));
});

describe('tagged draft keys', () => {
  it('separates Personal, an organization named personal, session new, and all draft targets', () => {
    const targets: DraftTarget[] = [
      { kind: 'new-session' },
      { kind: 'session', sessionId: 'new' },
      { kind: 'search' },
      { kind: 'quick-chat' },
    ];
    const keys = [null, 'personal', 'org:a\u0000b', 'org/a'].flatMap(org =>
      targets.map(target => scopedDraftKey(contextScope(org), target))
    );
    expect(new Set(keys).size).toBe(16);
    for (const key of keys) {
      expect(parseScopedDraftKey(key)).not.toBeNull();
    }
  });
  it('does not collide across delimiter positions or accept legacy keys as tagged keys', () => {
    expect(scopedDraftKey(contextScope('a:b'), { kind: 'session', sessionId: 'c' })).not.toBe(
      scopedDraftKey(contextScope('a'), { kind: 'session', sessionId: 'b:c' })
    );
    expect(parseScopedDraftKey('agent-composer:new')).toBeNull();
    expect(
      parseScopedDraftKey('context-draft:v1:[{"kind":"personal"},{"kind":"session"}]')
    ).toBeNull();
  });
});

describe('explicit legacy migration', () => {
  it.each([
    ['agent-composer:new', { kind: 'new-session' }],
    ['agent-composer:new', { kind: 'session', sessionId: 'new' }],
    ['agent-composer:session:a', { kind: 'session', sessionId: 'session:a' }],
    ['session-search-query', { kind: 'search' }],
    ['quick-chat:0:personal', { kind: 'quick-chat' }],
    ['quick-chat:37:personal', { kind: 'quick-chat' }],
  ] satisfies [string, DraftTarget][])(
    'confirms replacement before removing legacy %s for %j',
    async (legacy, target) => {
      seed(legacy);
      const input = migration(legacy, target);
      expect(await migrateLegacyDraft(input)).toBe('committed');
      expect(
        await loadDraftResult('oauth/a:用户', input.destinationKey, isStringDraft)
      ).toMatchObject({ status: 'present', value: 'legacy text' });
      expect(mock.bytes.has(storageKey('draft:oauth/a:用户', legacy))).toBe(false);
      expect(await migrateLegacyDraft(input)).toBe('absent');
      expect(mock.bytes.get(storageKey('draft:oauth/a:用户', input.destinationKey))).toBe(
        '"legacy text"'
      );
    }
  );
  it('lists multiple Quick Chat epochs without displaying or importing their text', async () => {
    seed('quick-chat:1:personal', 'first');
    seed('quick-chat:12:personal', 'second');
    const candidates = await listLegacyDraftCandidates(getAuthenticatedOwner());
    expect(candidates.map(candidate => candidate.key)).toEqual([
      'quick-chat:1:personal',
      'quick-chat:12:personal',
    ]);
    expect(JSON.stringify(candidates)).not.toContain('first');
    expect(JSON.stringify(candidates)).not.toContain('second');
    const input = migration('quick-chat:12:personal', { kind: 'quick-chat' });
    expect(await migrateLegacyDraft(input)).toBe('committed');
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', 'quick-chat:1:personal'))).toBe(
      '"first"'
    );
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', input.destinationKey))).toBe('"second"');
  });
  it('requires matching Quick Chat context even after a deliberate choice', async () => {
    seed('quick-chat:8:org-a');
    expect(await migrateLegacyDraft(migration('quick-chat:8:org-a', { kind: 'quick-chat' }))).toBe(
      'unavailable'
    );
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', 'quick-chat:8:org-a'))).toBe(
      '"legacy text"'
    );
    expect(
      await migrateLegacyDraft(migration('quick-chat:8:org-a', { kind: 'quick-chat' }, 'org-a'))
    ).toBe('committed');
  });
  it('requires a tagged explicit destination and does not infer Personal for search/new drafts', async () => {
    seed('session-search-query');
    seed('agent-composer:new');
    const input = migration('session-search-query', { kind: 'search' });
    expect(await migrateLegacyDraft({ ...input, destinationKey: 'session-search-query' })).toBe(
      'unavailable'
    );
    expect(mock.bytes.size).toBe(2);
  });
  it.each([
    { kilo_user_id: 'another-user', organization_id: null },
    { kilo_user_id: 'oauth/a:用户', organization_id: 'another-context' },
  ])('does not trust session route parameters when the server reports %j', async proof => {
    seed('agent-composer:s');
    mock.session.mockResolvedValue({ session_id: 's', ...proof });
    expect(
      await migrateLegacyDraft(migration('agent-composer:s', { kind: 'session', sessionId: 's' }))
    ).toBe('unavailable');
    expect(mock.bytes.size).toBe(1);
  });
  it('keeps the source and the prior destination after a failed replacement write', async () => {
    seed('agent-composer:new');
    mock.set.mockRejectedValueOnce(new Error('disk unavailable'));
    const input = migration('agent-composer:new', { kind: 'new-session' });
    expect(await migrateLegacyDraft(input)).toBe('failed');
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', 'agent-composer:new'))).toBe(
      '"legacy text"'
    );
    expect(mock.bytes.has(storageKey('draft:oauth/a:用户', input.destinationKey))).toBe(false);
    expect(await migrateLegacyDraft(input)).toBe('committed');
  });
  it('finishes an interrupted cleanup idempotently without overwriting the replacement', async () => {
    seed('session-search-query');
    mock.remove.mockRejectedValueOnce(new Error('temporary remove failure'));
    const input = migration('session-search-query', { kind: 'search' });
    expect(await migrateLegacyDraft(input)).toBe('committed');
    expect(mock.bytes.size).toBe(2);
    expect(await migrateLegacyDraft(input)).toBe('committed');
    expect(mock.bytes.size).toBe(1);
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', input.destinationKey))).toBe(
      '"legacy text"'
    );
  });
  it('does not overwrite a destination that already contains newer text', async () => {
    seed('session-search-query');
    const input = migration('session-search-query', { kind: 'search' });
    seed(input.destinationKey, 'newer text');
    expect(await migrateLegacyDraft(input)).toBe('conflict');
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', input.destinationKey))).toBe(
      '"newer text"'
    );
    expect(mock.bytes.size).toBe(2);
  });
  it('never cleans the source after its owner changes during a confirmed write', async () => {
    seed('agent-composer:new');
    const input = migration('agent-composer:new', { kind: 'new-session' });
    mock.set.mockImplementationOnce(async (scope: string, key: string, value: string) => {
      mock.bytes.set(storageKey(scope, key), value);
      signIn('account-b');
    });
    expect(await migrateLegacyDraft(input)).toBe('stale');
    expect(mock.bytes.get(storageKey('draft:oauth/a:用户', 'agent-composer:new'))).toBe(
      '"legacy text"'
    );
    expect([...mock.bytes.keys()].every(key => !key.includes('account-b'))).toBe(true);
  });
  it('preserves malformed legacy bytes without creating a destination', async () => {
    mock.bytes.set(storageKey('draft:oauth/a:用户', 'session-search-query'), '{broken');
    expect(await migrateLegacyDraft(migration('session-search-query', { kind: 'search' }))).toBe(
      'malformed'
    );
    expect([...mock.bytes.values()]).toEqual(['{broken']);
  });
});
