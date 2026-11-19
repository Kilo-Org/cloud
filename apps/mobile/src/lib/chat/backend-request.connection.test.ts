import { type FetchLike, ModelError } from '@kilocode/harness-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkBackendConnection } from './backend-request';
import { BackendInputError } from './backend-store';
import {
  DELTA_THEN_CUT,
  expectProblem,
  OK_STREAM,
  profile,
  serving,
  stalledCheck,
} from './backend-request.test-helpers';

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

afterEach(() => vi.useRealTimers());

describe('the backend connection check', () => {
  const CUT_EVENT = 'data: {"error":{"message":"cut","type":"server_error"}}\n\n';

  it.each(['max_completion_tokens', 'max_tokens'] as const)(
    'proves inference with the configured %s field rather than model discovery',
    async completionTokenField => {
      const transport = vi.fn(serving({ chunks: [OK_STREAM] }));
      await checkBackendConnection({ ...profile, completionTokenField }, 'manual-model', {
        signal: new AbortController().signal,
        transport,
      });
      const call = transport.mock.calls.at(0) as
        | [string, { headers: unknown; body?: string }]
        | undefined;
      expect(call).toBeDefined();
      const [url, request] = call as [string, { headers: unknown; body?: string }];
      expect(url).toBe('https://remote.example/v1/chat/completions');
      expect(request.headers).toEqual({
        authorization: 'Bearer private-key',
        'x-custom': 'private-header',
        'content-type': 'application/json',
      });
      const body: unknown = JSON.parse(request.body ?? '{}');
      expect(body).toMatchObject({
        model: 'manual-model',
        stream: true,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        [completionTokenField]: 16,
      });
      expect(body).not.toHaveProperty(
        completionTokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      );
    }
  );

  it('does not leak provider credentials on inference failure', async () => {
    const transport = vi.fn<FetchLike>().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Authorization: private-key private-header'),
    });
    await expectProblem(
      checkBackendConnection(profile, 'manual-model', {
        signal: new AbortController().signal,
        transport,
      }),
      'unauthorized'
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('renders the connection check deadline as timedOut', async () => {
    vi.useFakeTimers();
    const work = checkBackendConnection(profile, 'manual-model', {
      signal: new AbortController().signal,
      transport: stalledCheck(),
    });
    const outcome = expectProblem(work, 'timedOut');
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
    // A fiber that ran under the timeout must not leak past the test.
    await vi.runAllTimersAsync();
  });

  it('renders a caller abort during the connection check as cancelled', async () => {
    const controller = new AbortController();
    const work = checkBackendConnection(profile, 'manual-model', {
      signal: controller.signal,
      transport: stalledCheck(),
    });
    const outcome = expectProblem(work, 'cancelled');
    controller.abort();
    await outcome;
  });

  it('removes its abort listener from the caller signal when the check ends', async () => {
    const controller = new AbortController();
    type Listener = (event: Event) => void;
    const recorded: Listener[] = [];
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((_type, listener) => {
      recorded.push(listener as Listener);
    });
    vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((_type, listener) => {
      const at = recorded.indexOf(listener as Listener);
      if (at !== -1) {
        recorded.splice(at, 1);
      }
    });
    await expectProblem(
      checkBackendConnection(profile, 'manual-model', {
        signal: controller.signal,
        transport: serving({ chunks: [...DELTA_THEN_CUT] }),
      }),
      'incomplete'
    );
    expect(recorded).toEqual([]);
  });

  it.each([
    [{ chunks: [...DELTA_THEN_CUT] }, 'incomplete'],
    [{ chunks: [CUT_EVENT] }, 'incomplete'],
    [
      { failure: new ModelError({ reason: 'transport', cause: 'Remote request failed' }) },
      'unreachable',
    ],
  ] as const)('renders the check stream %s as %s', async (servingInput, problem) => {
    await expectProblem(
      checkBackendConnection(profile, 'manual-model', {
        signal: new AbortController().signal,
        transport: serving(servingInput),
      }),
      problem
    );
  });

  it('leaves an unknown model id on the input contract', async () => {
    const failure: unknown = await checkBackendConnection(profile, 'other-model', {
      signal: new AbortController().signal,
      transport: stalledCheck(),
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(BackendInputError);
  });
});
