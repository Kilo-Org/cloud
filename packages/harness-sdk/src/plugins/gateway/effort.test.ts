import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { fakeFetch, type Reply, sampleRequest } from './fake.js';
import { testGateway } from './test-gateway.js';
import { ModelClient } from '../../core/model.js';

/** These tests read the request, so the reply only has to arrive. */
const reply: Reply = { ok: true, status: 200, body: '', chunks: [] };

const bodyOf = async (kinds: readonly ApiKind[], effort: 'low' | 'high') => {
  const { calls, fetch } = fakeFetch([reply]);
  await ModelClient.pipe(
    Effect.map(client => client.stream({ ...sampleRequest(), effort })),
    Stream.unwrap,
    Stream.runDrain,
    Effect.either,
    Effect.provide(testGateway({ fetch, kinds })),
    Effect.runPromise
  );
  return JSON.parse(calls[0]?.request.body ?? '') as unknown;
};

it('names the effort as output_config on the messages shape', async () => {
  expect(await bodyOf(['messages'], 'high')).toMatchObject({ output_config: { effort: 'high' } });
});

it('names the effort as reasoning on the responses shape', async () => {
  expect(await bodyOf(['responses'], 'low')).toMatchObject({ reasoning: { effort: 'low' } });
});

it('names the effort as reasoning on the completions shape', async () => {
  expect(await bodyOf(['chat_completions'], 'low')).toMatchObject({ reasoning: { effort: 'low' } });
});
