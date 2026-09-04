import { Chunk, Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { completionsWire } from '../plugins/gateway/wire/completions.js';
import { messagesWire } from '../plugins/gateway/wire/messages.js';
import { responsesWire } from '../plugins/gateway/wire/responses.js';
import type { ModelEvent, StopReason } from './model.js';
import { run } from './session-fixture.js';

/**
 * The stop reason is the difference between a finished answer and one the wall
 * cut off mid-sentence. A caller that cannot tell them apart stores half a
 * thought and builds every later request on it.
 */

const stopOf = (events: Chunk.Chunk<ModelEvent>): StopReason | undefined => {
  const last = Chunk.toReadonlyArray(events).at(-1);
  return last?.kind === 'done' ? last.stop : undefined;
};

it('reports a finished answer as finished', async () => {
  const { value } = await run([{ deltas: ['all of it'] }], session =>
    Stream.runCollect(session.ask('why'))
  );
  expect(stopOf(value)).toBe('end');
});

it('reports an answer the ceiling cut off', async () => {
  const { value } = await run([{ deltas: ['half a th'], stop: 'maxTokens' }], session =>
    Stream.runCollect(session.ask('why'))
  );
  expect(stopOf(value)).toBe('maxTokens');
});

it('reads the stop reason of the messages shape', () => {
  expect(messagesWire.toStop({ delta: { stop_reason: 'end_turn' } })).toBe('end');
  expect(messagesWire.toStop({ delta: { stop_reason: 'stop_sequence' } })).toBe('end');
  expect(messagesWire.toStop({ delta: { stop_reason: 'max_tokens' } })).toBe('maxTokens');
  expect(messagesWire.toStop({ delta: { stop_reason: 'refusal' } })).toBe('refusal');
  /* A name this package has never seen is `unknown`, never a guess. */
  expect(messagesWire.toStop({ delta: { stop_reason: 'tool_use' } })).toBe('unknown');
  /* Every other frame says nothing, so it must not overwrite what was said. */
  expect(messagesWire.toStop({ delta: { text: 'he' } })).toBeUndefined();
  expect(messagesWire.toStop({ usage: { output_tokens: 4 } })).toBeUndefined();
});

it('reads the stop reason of the responses shape', () => {
  expect(responsesWire.toStop({ type: 'response.completed', response: {} })).toBe('end');
  expect(
    responsesWire.toStop({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    })
  ).toBe('maxTokens');
  expect(
    responsesWire.toStop({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    })
  ).toBe('refusal');
  expect(
    responsesWire.toStop({ type: 'response.output_text.delta', delta: 'he' })
  ).toBeUndefined();
});

it('reads the stop reason of the chat shape', () => {
  expect(completionsWire.toStop({ choices: [{ finish_reason: 'stop' }] })).toBe('end');
  expect(completionsWire.toStop({ choices: [{ finish_reason: 'length' }] })).toBe('maxTokens');
  expect(completionsWire.toStop({ choices: [{ finish_reason: 'content_filter' }] })).toBe(
    'refusal'
  );
  expect(completionsWire.toStop({ choices: [{ delta: { content: 'he' } }] })).toBeUndefined();
});

it('says unknown rather than guessing when the shape reported nothing', async () => {
  /* A gateway that relays a provider which sends no reason at all still has to
     answer the question, and `unknown` is the honest answer. */
  const { value } = await run([{ deltas: ['said'], stop: 'unknown' }], session =>
    Stream.runCollect(session.ask('why'))
  );
  expect(stopOf(value)).toBe('unknown');
});

it('keeps the answer of a call the ceiling cut off', async () => {
  /* A truncated answer is still the model's turn. Dropping it would lose what
     was paid for and shorten every prompt that follows. */
  const { value } = await run([{ deltas: ['half a th'], stop: 'maxTokens' }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );
  expect(Chunk.toReadonlyArray(value)[1]?.parts).toMatchObject([
    { kind: 'text', body: 'half a th' },
  ]);
});
