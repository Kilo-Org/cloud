import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { fakeFetch, type Reply, sampleRequest, sse } from './fake.js';
import { testGateway } from './test-gateway.js';
import { ModelClient, type ModelEvent } from '../../core/model.js';

const collect = async (kinds: readonly ApiKind[], chunks: readonly string[]) => {
  const reply: Reply = { ok: true, status: 200, body: '', chunks };
  const { calls, fetch } = fakeFetch([reply]);
  const events = await ModelClient.pipe(
    Effect.map(client => client.stream(sampleRequest())),
    Stream.unwrap,
    Stream.runCollect,
    Effect.map(chunk => [...chunk]),
    Effect.provide(testGateway({ fetch, kinds })),
    Effect.runPromise
  );
  return { calls, events };
};

const textOf = (events: readonly ModelEvent[]): string =>
  events
    .filter(event => event.kind === 'delta')
    .map(event => event.text)
    .join('');

it('streams the text of an Anthropic reply and ends with the token counts', async () => {
  const { calls, events } = await collect(
    ['messages'],
    sse(
      {
        type: 'message_start',
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 95 } },
      },
      { type: 'content_block_delta', delta: { text: 'he' } },
      { type: 'content_block_delta', delta: { text: 'llo' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }
    )
  );
  expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({ stream: true });
  expect(textOf(events)).toBe('hello');
  expect(events.at(-1)).toEqual({
    kind: 'done',
    usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 95, cacheWriteTokens: 0 },
    stop: 'end',
  });
});

it('joins a delta that arrives split over two chunks', async () => {
  const [first, second] = [
    'data: {"type":"content_block_delta","delta":{"te',
    'xt":"split"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
  ];
  const { events } = await collect(['messages'], [first ?? '', second ?? '']);
  expect(textOf(events)).toBe('split');
});

it('streams a completions reply and asks for its token counts', async () => {
  const { calls, events } = await collect(
    ['chat_completions'],
    sse(
      { choices: [{ delta: { content: 'hi' } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 9 },
        },
      }
    )
  );
  expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({
    stream_options: { include_usage: true },
  });
  expect(textOf(events)).toBe('hi');
  expect(events.at(-1)).toMatchObject({ usage: { cacheReadTokens: 9, inputTokens: 1 } });
});

it('streams a responses reply and names the cache key', async () => {
  const { calls, events } = await collect(
    ['responses'],
    sse(
      { type: 'response.output_text.delta', delta: 'yo' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 20,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 19 },
          },
        },
      }
    )
  );
  expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({ prompt_cache_key: 'ses_1' });
  expect(textOf(events)).toBe('yo');
  expect(events.at(-1)).toMatchObject({ usage: { cacheReadTokens: 19, inputTokens: 1 } });
});

const doneUsage = (events: readonly ModelEvent[]) => {
  const last = events.at(-1);
  return last?.kind === 'done' ? last.usage : undefined;
};

it('keeps the input counts when a later frame echoes zeros', async () => {
  const { events } = await collect(
    ['messages'],
    sse(
      {
        type: 'message_start',
        message: { usage: { input_tokens: 3, cache_read_input_tokens: 11_822 } },
      },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      {
        type: 'message_delta',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 42 },
      }
    )
  );

  expect(doneUsage(events)).toEqual({
    inputTokens: 3,
    outputTokens: 42,
    cacheReadTokens: 11_822,
    cacheWriteTokens: 0,
  });
});

it('ignores a token count that JSON.parse turned into Infinity', async () => {
  const { events } = await collect(
    ['chat_completions'],
    ['data: {"usage":{"prompt_tokens":1e999,"completion_tokens":1}}\n\n']
  );

  expect(doneUsage(events)).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

it('fails the stream when the provider reports an error part way through it', async () => {
  /* Anthropic's streaming reference: "The API may occasionally send errors in
     the event stream", such as an `overloaded_error` that would be a 529 on a
     call that was not streamed. Swallowing the frame stores a truncated answer
     as a whole one, and every later request is built on it. */
  const reply: Reply = {
    ok: true,
    status: 200,
    body: '',
    chunks: sse(
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'half an ans' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    ),
  };
  const { fetch } = fakeFetch([reply]);
  const result = await ModelClient.pipe(
    Effect.map(client => client.stream(sampleRequest())),
    Stream.unwrap,
    Stream.runCollect,
    Effect.either,
    Effect.provide(testGateway({ fetch, kinds: ['messages'] })),
    Effect.runPromise
  );

  expect(result).toMatchObject({ left: { reason: 'stream' } });
});
