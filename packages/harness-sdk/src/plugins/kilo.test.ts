import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ModelFacts } from '../core/catalog.js';
import { openSession } from '../core/run.js';
import { fakeFetch, type Reply, sse } from './gateway/fake.js';
import type { TokenSourceService } from '../core/token.js';
import { layerKilo } from './kilo.js';

/**
 * The composed layer. What is proved here is that one call gives a session
 * everything it asks for, and that the request that comes out is the one the
 * hand-wired layers made. How each plugin behaves is that plugin's own test.
 */

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

const ask = (token: string | TokenSourceService, facts?: ModelFacts) => {
  const { fetch, calls } = fakeFetch([answer]);
  const layers = layerKilo({
    baseUrl: 'https://gateway.test',
    org: { kind: 'organization', id: 'org_1' },
    fetch,
    token,
    ...(facts === undefined ? {} : { fallback: facts }),
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

it('sends a model it knows nothing about to the best shape there is', async () => {
  /* No catalog at all. The gateway relays every model through all three
     shapes, so assuming all three and picking the best one is what a caller
     who names nothing wants. */
  const { calls } = await Effect.runPromise(ask('tok_3'));

  expect(calls[0]?.url).toBe('https://gateway.test/api/gateway/v1/messages');
});

it('sends the model to the shape its catalog names', async () => {
  const { calls } = await Effect.runPromise(ask('tok_4', { apiKinds: ['chat_completions'] }));

  expect(calls[0]?.url).toBe('https://gateway.test/api/gateway/v1/chat/completions');
});

it('asks a token source for the credential rather than holding a string', async () => {
  /* The credential is the one plugin a long-lived caller has to replace, and
     the kilo token expires. Rewriting `layerKilo` to replace it means
     rebuilding the shared catalog by hand, which is the trap `layerKilo`
     closes, so the option takes a source too. */
  let asked = 0;
  const minting: TokenSourceService = {
    get: () =>
      Effect.sync(() => {
        asked += 1;
        return `tok_${String(asked)}`;
      }),
  };

  const { calls } = await Effect.runPromise(ask(minting));

  expect(asked).toBe(1);
  expect(calls[0]?.request.headers['authorization']).toBe('Bearer tok_1');
});
