import { Chunk, Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { completionsWire } from '../plugins/gateway/wire/completions.js';
import { messagesWire } from '../plugins/gateway/wire/messages.js';
import { responsesWire } from '../plugins/gateway/wire/responses.js';
import { textIn } from './prompt.js';
import { run } from './session-fixture.js';

const thinking = { deltas: ['the answer'], reasoning: ['first', ' second'] };

it('keeps the reasoning on the turn, ahead of what the model then said', async () => {
  const { value } = await run([thinking], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  const [, answer] = Chunk.toReadonlyArray(value);
  expect(answer?.parts).toMatchObject([
    { kind: 'reasoning', body: 'first second' },
    { kind: 'text', body: 'the answer' },
  ]);
});

it('adds no reasoning part when the model did none', async () => {
  const { value } = await run([{ deltas: ['plain'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  expect(Chunk.toReadonlyArray(value)[1]?.parts).toMatchObject([{ kind: 'text', body: 'plain' }]);
});

it('never sends the reasoning back in the next prompt', async () => {
  const { calls } = await run([thinking], session =>
    Effect.zipRight(
      Stream.runDrain(session.ask('why')),
      Stream.runDrain(session.ask('and then'))
    )
  );

  /* A thinking block returned without the signature the provider issued is
     refused, so the second call must carry the answer and not the thinking. */
  const second = calls[1]?.prompt.messages.map(textIn);
  expect(second).toEqual(['why', 'the answer', 'and then']);
});

it('streams the reasoning to the caller, marked as reasoning', async () => {
  const { value } = await run([thinking], session =>
    Stream.runCollect(session.ask('why'))
  );

  expect(
    Chunk.toReadonlyArray(value)
      .filter(event => event.kind === 'reasoning')
      .map(event => event.text)
  ).toEqual(['first', ' second']);
});

it('tells the thinking of each shape apart from its answer', () => {
  expect(messagesWire.toDelta({ delta: { thinking: 'hmm' } })).toEqual({
    kind: 'reasoning',
    text: 'hmm',
  });
  expect(messagesWire.toDelta({ delta: { text: 'said' } })).toEqual({
    kind: 'delta',
    text: 'said',
  });

  expect(
    responsesWire.toDelta({ type: 'response.reasoning_summary_text.delta', delta: 'hmm' })
  ).toEqual({ kind: 'reasoning', text: 'hmm' });

  /* Two providers relayed through the same shape name the field differently. */
  expect(completionsWire.toDelta({ choices: [{ delta: { reasoning: 'hmm' } }] })).toEqual({
    kind: 'reasoning',
    text: 'hmm',
  });
  expect(completionsWire.toDelta({ choices: [{ delta: { reasoning_content: 'hmm' } }] })).toEqual({
    kind: 'reasoning',
    text: 'hmm',
  });
  expect(completionsWire.toDelta({ choices: [{ delta: { content: 'said' } }] })).toEqual({
    kind: 'delta',
    text: 'said',
  });
});
