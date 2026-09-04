import { Chunk, Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { assemble } from '../plugins/prompt/default.js';
import { run } from './session-fixture.js';

/**
 * What a session does with the model's thinking: keeps it, seals it, and hands
 * it back on the next question. How each shape renders it is
 * `plugins/gateway/wire/replay.test.ts`.
 */

const thinking = {
  deltas: ['the answer'],
  reasoning: ['first', ' second'],
  signature: 'sig_abc',
};

it('keeps the reasoning and its signature, ahead of what the model then said', async () => {
  const { value } = await run([thinking], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  const [, answer] = value;
  expect(answer?.parts).toMatchObject([
    { kind: 'reasoning', body: 'first second', signature: 'sig_abc' },
    { kind: 'text', body: 'the answer' },
  ]);
});

it('adds no reasoning part when the model did none', async () => {
  const { value } = await run([{ deltas: ['plain'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  expect(value[1]?.parts).toMatchObject([{ kind: 'text', body: 'plain' }]);
});

it('keeps a thinking block that carries a signature and no words', async () => {
  /* A provider returns the thinking as a summary, and defaults to no summary
     at all. The block is then empty, is still billed, and still has to go back
     exactly as it came. Dropping it here would drop every block on that
     default. */
  const { value } = await run([{ deltas: ['said'], signature: 'sig_empty' }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  expect(value[1]?.parts).toMatchObject([
    { kind: 'reasoning', body: '', signature: 'sig_empty' },
    { kind: 'text', body: 'said' },
  ]);
});

it('sends the thinking back on the next question, unchanged', async () => {
  const { calls } = await run([thinking], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), Stream.runDrain(session.ask('and then')))
  );

  const answer = calls[1]?.prompt.messages[1];
  expect(answer?.parts).toEqual([
    { kind: 'reasoning', text: 'first second', signature: 'sig_abc' },
    { kind: 'text', text: 'the answer' },
  ]);
});

it('streams the reasoning to the caller, marked as reasoning', async () => {
  const { value } = await run([thinking], session => Stream.runCollect(session.ask('why')));

  expect(
    Chunk.toReadonlyArray(value)
      .filter(event => event.kind === 'reasoning')
      .map(event => event.text)
  ).toEqual(['first', ' second', '']);
});

it('carries the signature through the store and back into the prompt', async () => {
  const { value } = await run([thinking], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  const prompt = assemble({ system: 'sys', turns: value });
  expect(prompt.messages[1]?.parts[0]).toEqual({
    kind: 'reasoning',
    text: 'first second',
    signature: 'sig_abc',
  });
});

it('keeps thinking the provider encrypted, and hands it back byte for byte', async () => {
  /* A redacted block is thinking the provider would not show. It carries no
     signature and no words, and dropping it breaks the chain exactly as
     dropping a signed block does. */
  const { value, calls } = await run(
    [{ deltas: ['said'], redacted: ['ENCRYPTED_ONE', 'ENCRYPTED_TWO'] }, { deltas: ['after'] }],
    session =>
      Effect.zipRight(
        Effect.zipRight(Stream.runDrain(session.ask('why')), Stream.runDrain(session.ask('and'))),
        session.history
      )
  );

  expect(value[1]?.parts).toMatchObject([
    { kind: 'redacted', body: 'ENCRYPTED_ONE' },
    { kind: 'redacted', body: 'ENCRYPTED_TWO' },
    { kind: 'text', body: 'said' },
  ]);
  expect(calls[1]?.prompt.messages[1]?.parts).toEqual([
    { kind: 'redacted', data: 'ENCRYPTED_ONE' },
    { kind: 'redacted', data: 'ENCRYPTED_TWO' },
    { kind: 'text', text: 'said' },
  ]);
});
