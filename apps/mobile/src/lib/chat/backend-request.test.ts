import { type FetchLike } from '@kilocode/harness-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BackendDiscoveryFetch,
  backendHeaders,
  checkBackendConnection,
  discoverBackendModels,
} from './backend-request';
import { type ChatBackendDraft } from './backend-store';

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const profile: ChatBackendDraft = {
  name: 'Remote',
  baseUrl: 'https://remote.example/v1',
  apiKind: 'chat_completions',
  apiKey: 'private-key',
  headers: { 'X-Custom': 'private-header' },
  models: [{ id: 'manual-model', name: 'Manual', tools: false, images: false }],
  allowLocalHttp: false,
};

afterEach(() => vi.useRealTimers());

const requestChunk = new Promise<string>(resolve => {
  resolve(
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  );
});

const stalledDiscovery: BackendDiscoveryFetch = async (_url, request) => {
  const { promise, reject } = Promise.withResolvers<{ ok: boolean; text: () => Promise<string> }>();
  request.signal.addEventListener(
    'abort',
    () => {
      reject(new Error('private-key'));
    },
    { once: true }
  );
  await promise;
  return promise;
};

describe('remote backend requests', () => {
  it('uses only configured credentials and case-insensitive header overrides', () => {
    expect(backendHeaders(profile)).toEqual({
      authorization: 'Bearer private-key',
      'x-custom': 'private-header',
    });
    expect(backendHeaders({ ...profile, headers: { AUTHORIZATION: 'custom-auth' } })).toEqual({
      authorization: 'custom-auth',
    });
    expect(backendHeaders({ ...profile, apiKind: 'messages' })).toEqual({
      'x-api-key': 'private-key',
      'anthropic-version': '2023-06-01',
      'x-custom': 'private-header',
    });
    expect(backendHeaders({ ...profile, apiKey: '', headers: {} })).toEqual({});
  });

  it('discovers unique models without implicit tools or manual-list mutation', async () => {
    const transport = vi.fn<BackendDiscoveryFetch>().mockResolvedValue({
      ok: true,
      text: vi.fn<() => Promise<string>>().mockResolvedValue(
        JSON.stringify({
          data: [{ id: 'found' }, { id: 'found' }, { id: 'other', name: 'Other' }],
        })
      ),
    });
    const signal = new AbortController().signal;
    const found = await discoverBackendModels(profile, signal, transport);
    expect(found).toEqual([
      { id: 'found', name: 'found', tools: false, images: false },
      { id: 'other', name: 'Other', tools: false, images: false },
    ]);
    expect(profile.models).toEqual([
      { id: 'manual-model', name: 'Manual', tools: false, images: false },
    ]);
    expect(transport).toHaveBeenCalledWith(
      'https://remote.example/v1/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { authorization: 'Bearer private-key', 'x-custom': 'private-header' },
      })
    );
  });

  it('preserves manual models and masks provider text when discovery is unsupported', async () => {
    const transport = vi.fn<BackendDiscoveryFetch>().mockResolvedValue({
      ok: false,
      text: vi.fn<() => Promise<string>>().mockResolvedValue('private-key'),
    });
    await expect(
      discoverBackendModels(profile, new AbortController().signal, transport)
    ).rejects.toThrow('discoveryFailed');
    expect(profile.models[0]?.id).toBe('manual-model');
  });

  it('aborts discovery on its deadline', async () => {
    vi.useFakeTimers();
    const transport = stalledDiscovery;
    const work = discoverBackendModels(profile, new AbortController().signal, transport);
    const outcome = expect(work).rejects.toThrow('discoveryFailed');
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it.each(['max_completion_tokens', 'max_tokens'] as const)(
    'proves inference with the configured %s field rather than model discovery',
    async completionTokenField => {
      const transport = vi.fn<FetchLike>().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn<() => Promise<string>>().mockResolvedValue(''),
        stream: async function* stream() {
          yield await requestChunk;
        },
      });
      await checkBackendConnection({ ...profile, completionTokenField }, 'manual-model', {
        signal: new AbortController().signal,
        transport,
      });
      expect(transport).toHaveBeenCalledOnce();
      const call = transport.mock.calls[0];
      expect(call?.[0]).toBe('https://remote.example/v1/chat/completions');
      expect(call?.[1].headers).toEqual({
        authorization: 'Bearer private-key',
        'x-custom': 'private-header',
        'content-type': 'application/json',
      });
      const body: unknown = JSON.parse(call?.[1].body ?? '{}');
      expect(body).toMatchObject({
        model: 'manual-model',
        stream: true,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      });
      expect(body).toHaveProperty(completionTokenField, 16);
      expect(body).not.toHaveProperty(
        completionTokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      );
    }
  );

  it('does not leak provider credentials on inference failure', async () => {
    const transport = vi.fn<FetchLike>().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi
        .fn<() => Promise<string>>()
        .mockResolvedValue('Authorization: private-key private-header'),
    });
    await expect(
      checkBackendConnection(profile, 'manual-model', {
        signal: new AbortController().signal,
        transport,
      })
    ).rejects.toThrow('connectionFailed');
    expect(transport).toHaveBeenCalledOnce();
  });
});
