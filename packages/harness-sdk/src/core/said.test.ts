import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { type ModelEvent, said, zeroUsage } from './model.js';

/**
 * The fold from a stream of events down to the answer.
 *
 * It exists because twelve of this package's own live runs had written it out
 * by hand, and because it is the first thing anybody wants that `ask` does not
 * already give them. What it must get right is what it leaves out.
 */

const streamed = (events: readonly ModelEvent[]) =>
  Effect.runPromise(said(Stream.fromIterable(events)));

it('keeps the words and nothing else', async () => {
  const answer = await streamed([
    { kind: 'reasoning', text: 'let me think' },
    { kind: 'delta', text: 'there are ' },
    { kind: 'redacted', data: 'ZW5jcnlwdGVk' },
    { kind: 'delta', text: 'nine files' },
    { kind: 'toolCall', call: { id: 'tc_1', name: 'look', arguments: '{}' } },
    { kind: 'toolResult', result: { callId: 'tc_1', body: 'nine', failed: false } },
    { kind: 'done', usage: zeroUsage, stop: 'end' },
  ]);

  /* Thinking is not the answer, and neither is what a tool said. A reader shown
     either as the model's words would be shown something it never said. */
  expect(answer).toBe('there are nine files');
});

it('gives back what the model said after its tools, not before', async () => {
  const answer = await streamed([
    { kind: 'delta', text: 'looking' },
    { kind: 'toolCall', call: { id: 'tc_1', name: 'look', arguments: '{}' } },
    { kind: 'done', usage: zeroUsage, stop: 'tools' },
    { kind: 'toolResult', result: { callId: 'tc_1', body: 'nine', failed: false } },
    { kind: 'delta', text: 'there are nine' },
    { kind: 'done', usage: zeroUsage, stop: 'end' },
  ]);

  /* Both rounds, because both are what the model said in answer to the one
     question. A caller that wants only the last round watches `done` itself. */
  expect(answer).toBe('lookingthere are nine');
});

it('answers with nothing when the model said nothing', async () => {
  expect(await streamed([{ kind: 'done', usage: zeroUsage, stop: 'refusal' }])).toBe('');
});
