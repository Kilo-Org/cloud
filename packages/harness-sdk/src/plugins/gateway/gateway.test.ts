import { Effect, Either } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { fakeFetch, type Reply, sampleRequest } from './fake.js';
import { testGateway } from './test-gateway.js';
import type { FetchLike } from '../../core/fetch.js';
import type { OrgContext } from './http.js';
import { ModelClient } from '../../core/model.js';

const reply: Reply = {
  ok: true,
  status: 200,
  body: JSON.stringify({
    content: [{ type: 'text', text: 'hi' }],
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
    },
  }),
};

const call = async (options: {
  readonly org?: OrgContext;
  readonly kinds?: readonly ApiKind[];
  readonly replies?: readonly Reply[];
}) => {
  const { calls, fetch } = fakeFetch(options.replies ?? [reply]);
  const result = await ModelClient.pipe(
    Effect.flatMap(client => client.send(sampleRequest(false))),
    Effect.either,
    Effect.provide(
      testGateway({
        baseUrl: 'https://app.kilocode.ai/',
        fetch,
        retries: 2,
        ...(options.org === undefined ? {} : { org: options.org }),
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      })
    ),
    Effect.runPromise
  );
  return { calls, result };
};

it('posts to the messages endpoint with a bearer token', async () => {
  const { calls } = await call({});
  expect(calls[0]?.url).toBe('https://app.kilocode.ai/api/gateway/v1/messages');
  expect(calls[0]?.request.headers).toEqual({
    'content-type': 'application/json',
    authorization: 'Bearer tok',
  });
});

it('names the organization when the context is an organization', async () => {
  const { calls } = await call({ org: { kind: 'organization', id: 'org_1' } });
  expect(calls[0]?.request.headers['x-kilocode-organizationid']).toBe('org_1');
});

it('marks a cache breakpoint on the system block and on the last message', async () => {
  const { calls } = await call({});
  expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({
    system: [{ cache_control: { type: 'ephemeral' } }],
    messages: [
      { content: [{ text: 'a' }] },
      { content: [{ cache_control: { type: 'ephemeral' } }] },
    ],
  });
});

it('reads the token counts out of the reply', async () => {
  const { result } = await call({});
  expect(Either.getOrThrow(result)).toEqual({
    content: 'hi',
    usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 100 },
  });
});

it('prefers messages over the other two shapes', async () => {
  const { calls } = await call({ kinds: ['chat_completions', 'responses', 'messages'] });
  expect(calls[0]?.url).toMatch(/\/messages$/u);
});

it('falls back to the completions shape when a model speaks only that', async () => {
  const completion = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    }),
  };
  const { calls, result } = await call({ kinds: ['chat_completions'], replies: [completion] });
  expect(calls[0]?.url).toMatch(/\/chat\/completions$/u);
  expect(Either.getOrThrow(result).usage).toEqual({
    inputTokens: 1,
    outputTokens: 3,
    cacheReadTokens: 9,
    cacheWriteTokens: 0,
  });
});

it('reports that a model speaks no shape the gateway serves', async () => {
  const { calls, result } = await call({ kinds: [] });
  expect(calls).toHaveLength(0);
  expect(result).toMatchObject({ left: { reason: 'unsupported' } });
});

it('reports the status when the gateway rejects the call', async () => {
  const rejected: Reply = { ok: false, status: 402, body: 'no credit' };
  const { calls, result } = await call({ replies: [rejected] });
  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ left: { reason: 'status', status: 402 } });
});

it('tries again after a rate limit and then succeeds', async () => {
  const limited: Reply = { ok: false, status: 429, body: 'slow down' };
  const { calls, result } = await call({ replies: [limited, limited, reply] });
  expect(calls).toHaveLength(3);
  expect(Either.getOrThrow(result).content).toBe('hi');
});

it('gives up after the retry budget and reports the last status', async () => {
  const limited: Reply = { ok: false, status: 429, body: 'slow down' };
  const { calls, result } = await call({ replies: [limited] });

  /* Two retries on top of the first attempt. A budget that never ran out
     would hold the caller forever on an outage that does not clear. */
  expect(calls).toHaveLength(3);
  expect(result).toMatchObject({ left: { reason: 'status', status: 429 } });
});

it('retries a transport failure, which carries no status to judge', async () => {
  const calls: string[] = [];
  const failing: FetchLike = (url, request) => {
    calls.push(url);
    return calls.length < 3
      ? Promise.reject(new Error('socket hang up'))
      : Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(reply.body),
          request,
        });
  };
  const result = await ModelClient.pipe(
    Effect.flatMap(client => client.send(sampleRequest(false))),
    Effect.either,
    Effect.provide(testGateway({ fetch: failing, retries: 2 })),
    Effect.runPromise
  );

  expect(calls).toHaveLength(3);
  expect(Either.getOrThrow(result).content).toBe('hi');
});
