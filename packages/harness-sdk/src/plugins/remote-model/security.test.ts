import { Effect, Either, Schedule, Stream } from 'effect';
import { expect, it, vi } from 'vitest';
import { type FetchLike, ModelError, type ModelEvent } from '../../index.js';
import { webFetch } from '../fetch/web.js';
import { fakeFetch, sampleRequest, sse } from '../gateway/fake.js';
import { remoteModelClient, type RemoteModelConfig } from './index.js';

const retry = { schedule: Schedule.recurs(0) };
const configFor = (fetch: FetchLike): RemoteModelConfig => ({
  baseUrl: 'https://provider.example/v1',
  apiKind: 'chat_completions',
  fetch,
  headers: () =>
    Effect.succeed({ authorization: 'Bearer private-key', 'Content-Type': 'text/plain' }),
});

type FailureSource = 'status' | 'transport' | 'headers' | 'defect' | 'body' | 'stream' | 'redirect';
const reasonByFailure: Readonly<Record<FailureSource, ModelError['reason']>> = {
  status: 'status',
  transport: 'transport',
  headers: 'transport',
  defect: 'transport',
  body: 'body',
  stream: 'stream',
  redirect: 'status',
};

const failureConfig = (failure: FailureSource, fetch: FetchLike): RemoteModelConfig => {
  const config = configFor(
    failure === 'transport' ? () => Promise.reject(new Error('private-key')) : fetch
  );
  if (failure === 'headers') {
    return {
      ...config,
      headers: () => Effect.fail(new ModelError({ reason: 'transport', cause: 'private-key' })),
    };
  }
  if (failure === 'defect') {
    return { ...config, headers: () => Effect.die(new Error('private-key')) };
  }
  return config;
};

const responseForFailure = (failure: FailureSource) => {
  const statuses: Readonly<Partial<Record<FailureSource, number>>> = { status: 401, redirect: 307 };
  const chunks: Readonly<Partial<Record<FailureSource, readonly string[]>>> = {
    body: ['data: private-key\n\n'],
    stream: sse({ error: { message: 'private-key' } }),
  };
  return {
    ok: failure !== 'status' && failure !== 'redirect',
    status: statuses[failure] ?? 200,
    body: 'private-key',
    chunks: chunks[failure] ?? [],
  };
};

it('refreshes only this backend credentials on retry and overrides content type case-insensitively', async () => {
  const { fetch, calls } = fakeFetch([
    { ok: false, status: 503, body: 'private-key' },
    {
      ok: true,
      status: 200,
      body: '',
      chunks: sse({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }),
    },
  ]);
  let reads = 0;
  const client = remoteModelClient(
    {
      ...configFor(fetch),
      headers: () =>
        Effect.sync(() => ({
          authorization: `Bearer private-${++reads}`,
          'CONTENT-TYPE': 'wrong',
        })),
    },
    { schedule: Schedule.recurs(1) }
  );
  await Effect.runPromise(Stream.runDrain(client.stream(sampleRequest())));
  expect(calls.map(call => call.request.headers)).toEqual([
    { authorization: 'Bearer private-1', 'content-type': 'application/json' },
    { authorization: 'Bearer private-2', 'content-type': 'application/json' },
  ]);
});

it('isolates credentials between clients even when upstream model ids are identical', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: [] }]);
  await Promise.all(
    ['one', 'two'].map(key =>
      Effect.runPromise(
        Stream.runDrain(
          remoteModelClient(
            {
              ...configFor(fetch),
              baseUrl: `https://${key}.example/v1`,
              headers: () => Effect.succeed({ 'x-api-key': key }),
            },
            retry
          ).stream(sampleRequest())
        )
      )
    )
  );
  expect(calls.map(call => ({ url: call.url, key: call.request.headers['x-api-key'] }))).toEqual([
    { url: 'https://one.example/v1/chat/completions', key: 'one' },
    { url: 'https://two.example/v1/chat/completions', key: 'two' },
  ]);
});

it.each(['status', 'transport', 'headers', 'defect', 'body', 'stream', 'redirect'] as const)(
  'does not expose secrets from %s failures',
  async failure => {
    const echoed = 'private-key';
    const { fetch } = fakeFetch([responseForFailure(failure)]);
    const client = remoteModelClient(failureConfig(failure, fetch), retry);
    const result = await Effect.runPromise(
      Stream.runCollect(client.stream(sampleRequest())).pipe(Effect.either)
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(JSON.stringify(result.left)).not.toContain(echoed);
      expect(String(result.left)).not.toContain(echoed);
      expect(String(result.left.cause)).not.toContain(echoed);
      expect(result.left.reason).toBe(reasonByFailure[failure]);
    }
  }
);

it('keeps streamed fragments visible but emits no done after a provider error and never retries them', async () => {
  const { fetch, calls } = fakeFetch([
    {
      ok: true,
      status: 200,
      body: '',
      chunks: sse(
        { choices: [{ delta: { content: 'partial' } }] },
        { error: { message: 'private-key' } }
      ),
    },
  ]);
  const seen: ModelEvent[] = [];
  const client = remoteModelClient(configFor(fetch), { schedule: Schedule.recurs(3) });
  const result = await Effect.runPromise(
    client.stream(sampleRequest()).pipe(
      Stream.runForEach(event =>
        Effect.sync(() => {
          seen.push(event);
        })
      ),
      Effect.either
    )
  );
  expect(seen).toEqual([{ kind: 'delta', text: 'partial' }]);
  expect(result).toMatchObject({ left: { reason: 'stream' } });
  expect(calls).toHaveLength(1);
});

it('rejects credential-bearing roots and Kilo-specific headers without sending a request', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: [] }]);
  const credentialRoot = new URL('https://provider.example/v1');
  credentialRoot.username = 'test-user';
  credentialRoot.password = 'test-password';
  await Promise.all(
    [
      { ...configFor(fetch), baseUrl: credentialRoot.href },
      {
        ...configFor(fetch),
        headers: () => Effect.succeed({ 'X-KILOCODE-FEATURE': 'private-key' }),
      },
    ].map(async config => {
      const result = await Effect.runPromise(
        Stream.runDrain(remoteModelClient(config, retry).stream(sampleRequest())).pipe(
          Effect.either
        )
      );
      expect(Either.isLeft(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private-key');
      expect(JSON.stringify(result)).not.toContain('test-password');
    })
  );
  expect(calls).toHaveLength(0);
});

it('forwards fail-closed redirect policy and omits ambient cookies in the shipped web transport', async () => {
  const runtimeFetch = vi.fn(() =>
    Promise.reject(new Error('Cross-origin redirect carrying private-key'))
  );
  vi.stubGlobal('fetch', runtimeFetch);
  try {
    const result = await Effect.runPromise(
      Stream.runDrain(remoteModelClient(configFor(webFetch), retry).stream(sampleRequest())).pipe(
        Effect.either
      )
    );
    expect(result).toMatchObject({ left: { reason: 'transport' } });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(runtimeFetch).toHaveBeenCalledExactlyOnceWith(
      'https://provider.example/v1/chat/completions',
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        headers: { authorization: 'Bearer private-key', 'content-type': 'application/json' },
      })
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  { type: 'error', code: 'server_error', message: 'private-key' },
  { type: 'response.failed', response: { status: 'failed' } },
])(
  'fails on direct Responses error frames, including failures without nested error objects',
  async frame => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: '', chunks: sse(frame) }]);
    const result = await Effect.runPromise(
      Stream.runCollect(
        remoteModelClient({ ...configFor(fetch), apiKind: 'responses' }, retry).stream(
          sampleRequest()
        )
      ).pipe(Effect.either)
    );
    expect(result).toMatchObject({ left: { reason: 'stream' } });
    expect(JSON.stringify(result)).not.toContain('private-key');
  }
);

it('redacts synchronous stream reader defects as well as asynchronous transport errors', async () => {
  const privateMessage = 'private-key';
  const fetch: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      stream: () => {
        throw new Error(privateMessage);
      },
    });
  const result = await Effect.runPromise(
    Stream.runDrain(remoteModelClient(configFor(fetch), retry).stream(sampleRequest())).pipe(
      Effect.either
    )
  );
  expect(result).toMatchObject({ left: { reason: 'transport' } });
  expect(JSON.stringify(result)).not.toContain('private-key');
});
