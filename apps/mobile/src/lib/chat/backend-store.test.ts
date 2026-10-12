import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatBackendDraft } from './backend-store';

const { getItemAsync, setItemAsync, deleteItemAsync, randomUUID } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  randomUUID: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
vi.mock('expo-crypto', () => ({ randomUUID }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const draft: ChatBackendDraft = {
  name: 'Local model',
  baseUrl: 'https://models.example/v1/',
  apiKind: 'chat_completions',
  apiKey: 'old-account-secret',
  headers: {},
  allowLocalHttp: false,
  models: [{ id: 'same-name', name: 'Manual model', tools: false, images: false }],
};
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getItemAsync.mockResolvedValue(null);
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
  randomUUID.mockReset().mockReturnValueOnce(firstId).mockReturnValueOnce(secondId);
});

// Dynamic imports deliberately give each test a cold singleton and auth epoch.
describe('secure backend profiles', () => {
  it('keeps identity stable, increments revisions, and leaves old snapshots immutable', async () => {
    const store = await import('./backend-store');
    await store.waitForChatBackends();
    const first = store.addChatBackend(draft);
    const changed = store.updateChatBackend(first.id, {
      ...draft,
      name: 'Renamed',
      apiKey: 'new-secret',
    });
    expect(first.id).toBe(firstId);
    expect(changed).toMatchObject({ id: firstId, revision: 2, name: 'Renamed' });
    expect(first.revision).toBe(1);
    expect(first.apiKey).toBe('old-account-secret');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.models)).toBe(true);
    expect(Object.isFrozen(first.headers)).toBe(true);
    expect(Object.isFrozen(store.listChatBackends())).toBe(true);
    expect(changed.baseUrl).toBe('https://models.example/v1');
  });

  it('never reuses an identity after deleting and recreating an identical profile', async () => {
    const store = await import('./backend-store');
    await store.waitForChatBackends();
    const first = store.addChatBackend(draft);
    store.deleteChatBackend(first.id);
    expect(() => store.updateChatBackend(first.id, draft)).toThrow('staleBackend');
    const next = store.addChatBackend(draft);
    expect(next.id).toBe(secondId);
    expect(next.revision).toBe(1);
  });

  it('refuses a cold write rather than overwriting unread profiles', async () => {
    getItemAsync.mockReturnValue(Promise.withResolvers<string | null>().promise);
    const store = await import('./backend-store');
    expect(() => store.addChatBackend(draft)).toThrow('notLoaded');
  });

  it('an account reset fences a late disk read containing prior-account secrets', async () => {
    const { promise, resolve: finishRead } = Promise.withResolvers<string>();
    getItemAsync.mockReturnValue(promise);
    const store = await import('./backend-store');
    const auth = await import('@/lib/auth/auth-epoch');
    auth.bumpAuthEpoch();
    store.clearChatBackends();
    finishRead(JSON.stringify([{ ...draft, id: firstId, revision: 4 }]));
    await store.waitForChatBackends();
    expect(store.listChatBackends()).toEqual([]);
    expect(() => store.updateChatBackend(firstId, draft)).toThrow('staleBackend');
    randomUUID.mockReset().mockReturnValue(secondId);
    const next = store.addChatBackend({ ...draft, apiKey: '' });
    expect(next.apiKey).toBe('');
    expect(next.id).not.toBe(firstId);
    expect(store.listChatBackends().some(profile => profile.apiKey === 'old-account-secret')).toBe(
      false
    );
  });

  it('clears existing memory and removes its SecureStore record on account reset', async () => {
    const store = await import('./backend-store');
    await store.waitForChatBackends();
    const old = store.addChatBackend(draft);
    const auth = await import('@/lib/auth/auth-epoch');
    auth.bumpAuthEpoch();
    store.clearChatBackends();
    await new Promise<undefined>(resolve => {
      setImmediate(() => {
        resolve(undefined);
      });
    });
    expect(store.listChatBackends()).toEqual([]);
    expect(deleteItemAsync).toHaveBeenCalledWith('chat-backends');
    expect(() => store.updateChatBackend(old.id, draft)).toThrow('staleBackend');
  });

  it('validates persisted entries independently and rejects duplicate identities', async () => {
    const store = await import('./backend-store');
    const valid = { ...draft, id: firstId, revision: 1 };
    expect(
      store.parseChatBackends(
        JSON.stringify([
          { ...valid, headers: { Authorization: 42 } },
          valid,
          valid,
          { ...valid, id: secondId, models: [] },
        ])
      )
    ).toEqual([
      {
        ...valid,
        baseUrl: 'https://models.example/v1',
        completionTokenField: 'max_completion_tokens',
      },
    ]);
    expect(store.parseChatBackends('bad json')).toEqual([]);
  });

  it.each([
    { name: ' ' },
    { models: [] },
    { models: [draft.models[0], draft.models[0]] },
    { headers: { 'invalid header': 'secret' } },
    { headers: { authorization: 'secret\r\ninjected: true' } },
    { headers: { 'X-KILOCODE-FEATURE': 'mobile-chat' } },
    { headers: { 'x-kilo-organization-id': 'org' } },
    { headers: { Authorization: 'one', authorization: 'two' } },
    { headers: { 'Content-Type': 'application/json' } },
    { apiKind: 'unknown' },
    { completionTokenField: 'max_output_tokens' },
    { completionTokenField: null },
    { apiKey: 'secret\n' },
    { headers: { Authorization: 'invalid-\u0100' } },
    { models: [{ id: 'bad\nid', name: 'Bad', tools: false }] },
  ])('rejects invalid user input without leaking secrets: %j', async patch => {
    const store = await import('./backend-store');
    expect(() => store.validateChatBackendDraft({ ...draft, ...patch })).toThrow('invalidInput');
  });

  it('persists the selected limit field and defaults profiles that predate the setting', async () => {
    // A cold import exercises the singleton's SecureStore loading boundary.
    const store = await import('./backend-store');
    await store.waitForChatBackends();
    const first = store.addChatBackend(draft);
    expect(first.completionTokenField).toBe('max_completion_tokens');
    const changed = store.updateChatBackend(first.id, {
      ...draft,
      completionTokenField: 'max_tokens',
    });
    expect(store.parseChatBackends(JSON.stringify([changed]))[0]).toMatchObject({
      revision: 2,
      completionTokenField: 'max_tokens',
    });
    expect(first.completionTokenField).toBe('max_completion_tokens');
  });

  it('reads a stored model without the image flag as text-only, and keeps a set flag', async () => {
    const store = await import('./backend-store');
    const stored = {
      ...draft,
      id: firstId,
      revision: 1,
      models: [
        { id: 'old', name: 'Stored before images', tools: true },
        { id: 'vision', name: 'Reads images', tools: false, images: true },
      ],
    };
    expect(store.parseChatBackends(JSON.stringify([stored]))[0]?.models).toEqual([
      { id: 'old', name: 'Stored before images', tools: true, images: false },
      { id: 'vision', name: 'Reads images', tools: false, images: true },
    ]);
  });
});
