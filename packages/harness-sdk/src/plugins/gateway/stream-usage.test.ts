import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { ModelClient } from '../../core/model.js';
import { fakeFetch, sampleRequest, sse } from './fake.js';
import { testGateway } from './test-gateway.js';

const served = 'anthropic/claude-sonnet-4.6';
const requested = 'kilo-auto/balanced';

const framesFor = (kind: ApiKind, costs: object = {}): readonly unknown[] => {
  if (kind === 'messages') {
    return [
      {
        type: 'message_start',
        message: {
          model: served,
          usage: { input_tokens: 3, cache_read_input_tokens: 7, ...costs },
        },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2, ...costs },
      },
    ];
  }
  if (kind === 'responses') {
    return [
      { type: 'response.created', response: { model: served } },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 7 },
            output_tokens: 2,
            ...costs,
          },
        },
      },
    ];
  }
  return [
    { model: served, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens: 2,
        ...costs,
      },
    },
  ];
};

const collect = async (kind: ApiKind, frames: readonly unknown[]) => {
  const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: sse(...frames) }]);
  const events = await ModelClient.pipe(
    Effect.map(client => client.stream({ ...sampleRequest(), model: requested })),
    Stream.unwrap,
    Stream.runCollect,
    Effect.provide(testGateway({ fetch, kinds: [kind] })),
    Effect.runPromise
  );
  return { done: [...events].at(-1), calls };
};

it.each<ApiKind>(['chat_completions', 'messages', 'responses'])(
  'preserves the served model and billed cost for %s without changing the requested target',
  async kind => {
    const { done, calls } = await collect(kind, framesFor(kind, { cost: 0.000_42 }));

    expect(done).toEqual({
      kind: 'done',
      model: served,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 7,
        cacheWriteTokens: 0,
        cost: 0.000_42,
      },
      stop: 'end',
    });
    expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({ model: requested });
  }
);

it.each<ApiKind>(['chat_completions', 'messages', 'responses'])(
  'keeps unknown cost distinct from free for %s',
  async kind => {
    const missing = await collect(kind, framesFor(kind));
    const free = await collect(kind, framesFor(kind, { cost: 0 }));
    const malformed = await collect(kind, framesFor(kind, { cost: '0.01' }));

    expect(missing.done).toMatchObject({
      model: served,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(missing.done?.kind === 'done' ? missing.done.usage : undefined).not.toHaveProperty(
      'cost'
    );
    expect(free.done).toMatchObject({ model: served, usage: { cost: 0 } });
    expect(malformed.done?.kind === 'done' ? malformed.done.usage : undefined).not.toHaveProperty(
      'cost'
    );
  }
);

it.each<ApiKind>(['chat_completions', 'messages', 'responses'])(
  'bills a provider-key call at its upstream cost, not the OpenRouter fee, for %s',
  async kind => {
    const { done } = await collect(
      kind,
      framesFor(kind, {
        cost: 0.000_000_6,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.000_012 },
      })
    );

    expect(done).toMatchObject({ model: served, usage: { cost: 0.000_012 } });
  }
);

it('ignores malformed model metadata while retaining valid usage', async () => {
  const { done } = await collect('chat_completions', [
    { model: 42, usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 } },
    { model: '' },
  ]);

  expect(done).toEqual({
    kind: 'done',
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
    },
    stop: 'unknown',
  });
});
