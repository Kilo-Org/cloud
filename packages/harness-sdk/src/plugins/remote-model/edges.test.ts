import { Effect, Schedule, Stream } from 'effect';
import { expect, it } from 'vitest';
import { fakeFetch, sampleRequest, sse } from '../gateway/fake.js';
import { remoteModelClient } from './index.js';

const retry = { schedule: Schedule.recurs(0) };

it('does not treat an empty Responses refusal frame as a refusal', async () => {
  const { fetch } = fakeFetch([
    {
      ok: true,
      status: 200,
      body: '',
      chunks: sse(
        { type: 'response.refusal.delta', delta: '' },
        { type: 'response.output_text.delta', delta: 'Answer' },
        { type: 'response.completed', response: { status: 'completed' } }
      ),
    },
  ]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'responses',
      fetch,
      headers: () => Effect.succeed({}),
    },
    retry
  );
  const events = await Effect.runPromise(Stream.runCollect(client.stream(sampleRequest())));
  expect([...events].at(-1)).toMatchObject({ kind: 'done', stop: 'end' });
});

it('rejects max effort for direct Chat Completions before sending a request', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: [] }]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      fetch,
      headers: () => Effect.succeed({}),
    },
    retry
  );
  const result = await Effect.runPromise(
    Effect.either(Stream.runDrain(client.stream({ ...sampleRequest(), effort: 'max' })))
  );
  expect(result).toMatchObject({ left: { reason: 'unsupported' } });
  expect(calls).toHaveLength(0);
});
