import { type FetchLike, ModelError } from '@kilocode/harness-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BackendDiscoveryFetch,
  backendHeaders,
  checkBackendConnection,
  discoverBackendModels,
} from './backend-request';
import {
  type BackendConnection,
  BackendInputError,
  BackendRequestError,
  type BackendRequestProblem,
  type ChatBackendDraft,
} from './backend-store';

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
  models: [{ id: 'manual-model', name: 'Manual', tools: false, images: false, reasoning: false }],
  allowLocalHttp: false,
};

afterEach(() => vi.useRealTimers());

const OK_STREAM =
  'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** A provider failure event the wire reads as a stream reason, plus its pieces. */
const DELTA = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n';
const CUT_EVENT = 'data: {"error":{"message":"cut","type":"server_error"}}\n\n';
const END_EVENT = 'data: [DONE]\n\n';
const DELTA_THEN_CUT = [DELTA, CUT_EVENT, END_EVENT] as const;

const stalledDiscovery: BackendDiscoveryFetch = async (_url, request) => {
  const { promise, reject } = Promise.withResolvers<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>();
  const abort = () => {
    const abortError = new Error('private-key');
    abortError.name = 'AbortError';
    reject(abortError);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  await promise;
  return promise;
};

/** Plain transport failure, not an abort; provider text rides along. */
const unreachableDiscovery: BackendDiscoveryFetch = async () => {
  await Promise.resolve();
  throw new TypeError('fetch failed: private-key private-header');
};

/** One check transport builder: `failure` set fails the stream after its chunks, else the chunks play out. */
const serving = ({
  chunks = [''],
  failure,
}: {
  chunks?: readonly string[];
  failure?: ModelError;
}): FetchLike =>
  async () => {
    await Promise.resolve('serving');
    return {
      ok: true,
      status: 200,
      text: vi.fn<() => Promise<string>>().mockResolvedValue(''),
      stream: async function* stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
        if (failure !== undefined) {
          throw failure;
        }
      },
    };
  };

/** A check transport that answers nothing: only the deadline or a caller abort ends it. */
const stalledCheck = (): FetchLike => vi.fn<FetchLike>().mockImplementation(() => new Promise<never>(() => undefined));

/** One discovery transport, with the body and status a test names. */
const discoveryAnswering = (body: string, status = 200): BackendDiscoveryFetch =>
  async () => {
    const text = await Promise.resolve(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: vi.fn<() => Promise<string>>().mockResolvedValue(text),
    };
  };

/** Asserts the problem class and that no provider text escapes the error. */
async function expectProblem(work: Promise<unknown>, problem: BackendRequestProblem): Promise<void> {
  const failure: unknown = await work.then(
    () => null,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(BackendRequestError);
  expect((failure as BackendRequestError).problem).toBe(problem);
  // Provider text can echo authorization headers or API keys, so nothing but
  // the problem name may speak.
  expect((failure as Error).message).not.toMatch(/private-key|private-header/u);
  expect(String(failure)).not.toMatch(/private-key|private-header/u);
}

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
    const transport = discoveryAnswering(JSON.stringify({ data: [{ id: 'found' }, { id: 'found' }, { id: 'other', name: 'Other' }] }));
    const found = await discoverBackendModels(profile, new AbortController().signal, transport);
    expect(found).toEqual([
      { id: 'found', name: 'found', tools: false, images: false, reasoning: false },
      { id: 'other', name: 'Other', tools: false, images: false, reasoning: false },
    ]);
    expect(profile.models[0]?.id).toBe('manual-model');
  });

  it('reports a caller abort as cancelled, not from the deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectProblem(
      discoverBackendModels(profile, controller.signal, stalledDiscovery),
      'cancelled'
    );
  });

  it('reports a deadline whose transport rejected with AbortError as timedOut', async () => {
    vi.useFakeTimers();
    const work = discoverBackendModels(profile, new AbortController().signal, stalledDiscovery);
    const outcome = expectProblem(work, 'timedOut');
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'notFound'],
    [429, 'rateLimited'],
    [503, 'unavailable'],
    [400, 'invalidResponse'],
  ] as const)('renders a %i discovery refusal as %s', async (status, problem) => {
    // The refused body carries credentials; a wrong-model refusal does not.
    const body = status === 400 ? 'private-header' : 'no models here';
    await expectProblem(
      discoverBackendModels(profile, new AbortController().signal, discoveryAnswering(body, status)),
      problem
    );
  });

  it.each([
    ['private-header', 400, 'invalidResponse'],
    [{ data: [{ id: '' }] }, 400, 'invalidResponse'],
    [{ data: [] }, 200, 'noModels'],
  ] as const)('renders discovery body %s with status %i as %s', async (body, status, problem) => {
    await expectProblem(
      discoverBackendModels(
        profile,
        new AbortController().signal,
        discoveryAnswering(JSON.stringify(body), status)
      ),
      problem
    );
  });

  it('preserves manual models when discovery is unsupported', async () => {
    await expectProblem(
      discoverBackendModels(profile, new AbortController().signal, discoveryAnswering('private-key', 404)),
      'notFound'
    );
    expect(profile.models[0]?.id).toBe('manual-model');
  });

  it('renders a network rejection as unreachable', async () => {
    await expectProblem(
      discoverBackendModels(profile, new AbortController().signal, unreachableDiscovery),
      'unreachable'
    );
  });

  it('leaves draft validation failures on the input contract', async () => {
    // A model list is required input; without one the connection is invalid.
    const invalid: unknown = { baseUrl: 'https://remote.example/v1', apiKind: 'chat_completions', models: [] };
    const failure: unknown = await discoverBackendModels(
      invalid as BackendConnection,
      new AbortController().signal
    ).then(
      () => null,
      (error: unknown) => error
    );
    // The form reads the input contract, so the request class must not shadow it.
    expect(failure).toBeInstanceOf(BackendInputError);
    expect(failure).not.toBeInstanceOf(BackendRequestError);
  });

  it.each(['max_completion_tokens', 'max_tokens'] as const)(
    'proves inference with the configured %s field rather than model discovery',
    async completionTokenField => {
      const transport = vi.fn(serving({ chunks: [await Promise.resolve(OK_STREAM)] }));
      await checkBackendConnection({ ...profile, completionTokenField }, 'manual-model', {
        signal: new AbortController().signal,
        transport,
      });
      const call = transport.mock.calls.at(0) as [string, { headers: unknown; body?: string }] | undefined;
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

  it.each([
    [{ chunks: [...DELTA_THEN_CUT] }, 'incomplete'],
    [{ chunks: [CUT_EVENT] }, 'incomplete'],
    [{ failure: new ModelError({ reason: 'transport', cause: 'Remote request failed' }) }, 'unreachable'],
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
