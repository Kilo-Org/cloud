import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { openSession } from '../core/run.js';
import { fakeFetch, type Reply } from './gateway/fake.js';
import { layerKilo } from './kilo.js';

/**
 * The composed layer. What is proved here is that one call gives a session
 * everything it asks for, and that the request that comes out is the one the
 * hand-wired layers made. How each plugin behaves is that plugin's own test.
 */

const sse = (...events: readonly unknown[]): readonly string[] =>
  events.map(event => `data: ${JSON.stringify(event)}\n\n`);

const answer: Reply = {
  ok: true,
  status: 200,
  body: '',
  chunks: sse(
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_delta', delta: { text: 'hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  ),
};

const ask = (token: string) => {
  const { fetch, calls } = fakeFetch([answer]);
  const layers = layerKilo({
    baseUrl: 'https://gateway.test',
    org: { kind: 'organization', id: 'org_1' },
    fetch,
    token,
    fallback: { apiKinds: ['messages'] },
  });
  const said = Effect.scoped(
    Effect.flatMap(openSession({ system: 'sys', model: 'm', maxTokens: 8 }), session =>
      Stream.runFold(session.ask('hi'), '', (held, event) =>
        event.kind === 'delta' ? held + event.text : held
      )
    )
  );
  return Effect.map(Effect.provide(said, layers), text => ({ text, calls }));
};

it('gives a session every plugin it asks for, in one call', async () => {
  const { text } = await Effect.runPromise(ask('tok_1'));

  expect(text).toBe('hello');
});

it('sends the token and the organization the caller named', async () => {
  const { calls } = await Effect.runPromise(ask('tok_2'));

  expect(calls[0]?.request.headers).toMatchObject({
    authorization: 'Bearer tok_2',
    'x-kilocode-organizationid': 'org_1',
  });
});

it('sends the model to the shape its catalog names', async () => {
  const { calls } = await Effect.runPromise(ask('tok_3'));

  expect(calls[0]?.url).toBe('https://gateway.test/api/gateway/v1/messages');
});
