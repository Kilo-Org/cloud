import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackendInputError,
  type ChatBackendDraft,
  parseChatBackendHeaders,
  parseChatBackends,
  validateBackendConnection,
  validateChatBackendDraft,
} from './backend-store';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
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
const profileId = '00000000-0000-4000-8000-000000000001';

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
  vi.clearAllMocks();
  getItemAsync.mockResolvedValue(null);
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
});

describe('chat backend header rules', () => {
  // z.record skips an own `__proto__` key while parsing, so only a check on the raw
  // input can refuse it; these cases pin that every entry path answers for it.
  it.each(['{"__proto__":"v"}', '{"__PROTO__":"v"}', '{"__proto__":"v","Authorization":"a"}'])(
    'refuses a prototype header key instead of dropping it: %s',
    input => {
      expect(() => parseChatBackendHeaders(input)).toThrow(/^invalidHeaders$/u);

      const headers = JSON.parse(input) as Record<string, string>;
      const save = captureError(() => validateChatBackendDraft({ ...draft, headers }));
      expect((save as BackendInputError).problem).toBe('invalidHeaders');
      expect(() => validateBackendConnection({ ...draft, headers })).toThrow(/^invalidHeaders$/u);

      // No shipped build could have written that key, so the stored read drops the profile.
      const stored = { ...draft, headers, id: profileId, revision: 1 };
      expect(parseChatBackends(JSON.stringify([stored]))).toEqual([]);
    }
  );

  it('refuses only that key: a plain header still parses and saves', () => {
    expect(parseChatBackendHeaders('{"Authorization":"a"}')).toMatchObject({ Authorization: 'a' });
    expect(
      validateChatBackendDraft({ ...draft, headers: { Authorization: 'a' } }).headers
    ).toMatchObject({ Authorization: 'a' });
  });

  it('names the field rather than quoting the issue, so no header key or value reaches the message', () => {
    const headers = JSON.parse('{"__proto__":"Authorization"}') as Record<string, string>;
    const failure = captureError(() => validateChatBackendDraft({ ...draft, headers }));
    expect(failure).toBeInstanceOf(BackendInputError);
    expect((failure as BackendInputError).problem).toBe('invalidHeaders');
    expect(failure.message).toBe('invalidHeaders');
  });
});
