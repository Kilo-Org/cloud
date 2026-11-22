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
  models: [
    { id: 'same-name', name: 'Manual model', tools: false, images: false, reasoning: false },
  ],
};
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';

/** The error a call throws, so an assertion can read a typed problem instead of the message. */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected the call to throw');
}

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
    await vi.waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith('chat-backends');
    });
    expect(store.listChatBackends()).toEqual([]);
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
    { headers: { Authorization: 'invalid-\u0100' } },
    { models: [{ id: 'bad\nid', name: 'Bad', tools: false }] },
  ])('rejects invalid user input without leaking secrets: %j', async patch => {
    const store = await import('./backend-store');
    expect(() => store.validateChatBackendDraft({ ...draft, ...patch })).toThrow(/^invalidInput$/u);
  });

  it('trims whitespace around the API key and keeps the key body intact', async () => {
    const store = await import('./backend-store');
    const parsed = store.validateChatBackendDraft({ ...draft, apiKey: ' new-secret\n' });
    expect(parsed.apiKey).toBe('new-secret');
  });

  it('names a control character inside the API key without quoting the key', async () => {
    const store = await import('./backend-store');
    const failure = captureError(() =>
      store.validateChatBackendDraft({ ...draft, apiKey: 'sec\nret' })
    );
    expect(failure).toBeInstanceOf(store.BackendInputError);
    expect((failure as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidApiKey');
    expect(failure.message).toBe('invalidApiKey');
    expect(failure.message).not.toContain('sec');
    expect(failure.message).not.toContain('ret');

    const connection = captureError(() =>
      store.validateBackendConnection({ ...draft, apiKey: 'sec\nret' })
    );
    expect((connection as InstanceType<typeof store.BackendInputError>).problem).toBe(
      'invalidApiKey'
    );
  });

  it('refuses an invisible C1 control inside the API key without quoting the key', async () => {
    const store = await import('./backend-store');
    const failure = captureError(() =>
      store.validateChatBackendDraft({ ...draft, apiKey: 'sec\u0085ret' })
    );
    expect(failure).toBeInstanceOf(store.BackendInputError);
    expect((failure as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidApiKey');
    expect(failure.message).not.toContain('sec');
    expect(failure.message).not.toContain('ret');

    const connection = captureError(() =>
      store.validateBackendConnection({ ...draft, apiKey: 'sec\u0085ret' })
    );
    expect((connection as InstanceType<typeof store.BackendInputError>).problem).toBe(
      'invalidApiKey'
    );
  });

  it('keeps a stored profile whose key holds a C1 control, while a save still refuses it', async () => {
    const store = await import('./backend-store');
    const stored = { ...draft, apiKey: 'sec\u0085ret', id: firstId, revision: 3 };
    expect(store.parseChatBackends(JSON.stringify([stored]))).toMatchObject([
      {
        id: firstId,
        revision: 3,
        name: 'Local model',
        baseUrl: 'https://models.example/v1',
        apiKey: 'sec\u0085ret',
        models: draft.models,
      },
    ]);
    expect(store.parseChatBackends(JSON.stringify([stored]))[0]?.apiKey).toBe('sec\u0085ret');

    const save = captureError(() => store.validateChatBackendDraft(stored));
    expect((save as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidApiKey');
    const connection = captureError(() => store.validateBackendConnection(stored));
    expect((connection as InstanceType<typeof store.BackendInputError>).problem).toBe(
      'invalidApiKey'
    );
  });

  it('keeps a stored profile whose header value holds a C1 control, while a save refuses it', async () => {
    const store = await import('./backend-store');
    const stored = {
      ...draft,
      headers: { Authorization: 'Bearer sec\u0085ret' },
      id: secondId,
      revision: 1,
    };
    expect(store.parseChatBackends(JSON.stringify([stored]))).toMatchObject([
      { id: secondId, headers: { Authorization: 'Bearer sec\u0085ret' } },
    ]);

    const save = captureError(() => store.validateChatBackendDraft(stored));
    expect(save).toBeInstanceOf(store.BackendInputError);
    expect((save as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidInput');
  });

  it('drops a stored profile holding a value no build could have stored', async () => {
    const store = await import('./backend-store');
    const keyWithLineBreak = { ...draft, apiKey: 'sec\r\nret', id: firstId, revision: 1 };
    expect(store.parseChatBackends(JSON.stringify([keyWithLineBreak]))).toEqual([]);

    const headerWithNul = {
      ...draft,
      headers: { Authorization: 'Bearer a\u0000b' },
      id: secondId,
      revision: 1,
    };
    expect(store.parseChatBackends(JSON.stringify([headerWithNul]))).toEqual([]);
  });

  it('names the API key before a blank name, so one line reports the credential problem', async () => {
    const store = await import('./backend-store');
    const failure = captureError(() =>
      store.validateChatBackendDraft({ ...draft, name: ' ', apiKey: 'sec\u0085ret' })
    );
    expect((failure as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidApiKey');
  });

  it('refuses a C1 control inside a header value on the save path and the header parser', async () => {
    const store = await import('./backend-store');
    const failure = captureError(() =>
      store.validateChatBackendDraft({ ...draft, headers: { Authorization: 'a\u0085b' } })
    );
    expect((failure as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidInput');
    expect(() => store.parseChatBackendHeaders(String.raw`{"Authorization":"a\u0085b"}`)).toThrow(
      /^invalidInput$/u
    );
  });

  it('keeps a printable Latin-1 letter in the API key intact', async () => {
    const store = await import('./backend-store');
    const parsed = store.validateChatBackendDraft({ ...draft, apiKey: 'señor-key' });
    expect(parsed.apiKey).toBe('señor-key');
  });

  it('reports a failure that names no field as invalidInput', async () => {
    const store = await import('./backend-store');
    const failure = captureError(() => store.validateChatBackendDraft({ ...draft, name: ' ' }));
    expect(failure).toBeInstanceOf(store.BackendInputError);
    expect((failure as InstanceType<typeof store.BackendInputError>).problem).toBe('invalidInput');
    expect(failure.message).toBe('invalidInput');

    const wrongType = captureError(() => store.validateChatBackendDraft({ ...draft, apiKey: 42 }));
    expect((wrongType as InstanceType<typeof store.BackendInputError>).problem).toBe(
      'invalidInput'
    );
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
        { id: 'vision', name: 'Reads images', tools: false, images: true, reasoning: false },
      ],
    };
    expect(store.parseChatBackends(JSON.stringify([stored]))[0]?.models).toEqual([
      { id: 'old', name: 'Stored before images', tools: true, images: false, reasoning: false },
      { id: 'vision', name: 'Reads images', tools: false, images: true, reasoning: false },
    ]);
  });
});
