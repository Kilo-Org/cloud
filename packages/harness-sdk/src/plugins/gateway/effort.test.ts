import { Effect } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind } from '../../core/catalog.js';
import { fakeFetch, type Reply, sampleRequest } from './fake.js';
import { testGateway } from './test-gateway.js';
import { ModelClient } from '../../core/model.js';

const reply: Reply = {
  ok: true,
  status: 200,
  body: JSON.stringify({
    content: [{ type: 'text', text: 'hi' }],
    choices: [{ message: { content: 'hi' } }],
    output: [{ content: [{ text: 'hi' }] }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
    },
  }),
};

const bodyOf = async (kinds: readonly ApiKind[], effort: 'low' | 'high') => {
  const { calls, fetch } = fakeFetch([reply]);
  await ModelClient.pipe(
    Effect.flatMap(client => client.send({ ...sampleRequest(false), effort })),
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
