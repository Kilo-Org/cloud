import { assert } from 'typia';
import { expect, it } from 'vitest';
import type { Prompt } from '../../../core/prompt.js';
import { completionsWire } from './completions.js';
import { messagesWire } from './messages.js';
import { responsesWire } from './responses.js';

/**
 * The same prompt through each shape, read back as text.
 *
 * Every shape spells the system prompt differently — a block list, a string, a
 * message with a role of its own — and until 2026-09-04 nothing here asserted
 * two of the three. A shape that dropped or replaced the system prompt passed
 * the whole suite and failed only against a live model, which is late and
 * expensive to read.
 */

const prompt: Prompt = {
  system: [{ text: 'the system prompt', cache: true }],
  messages: [
    { role: 'user', parts: [{ kind: 'text', text: 'the question' }], cache: false },
    { role: 'assistant', parts: [{ kind: 'text', text: 'the answer' }], cache: true },
  ],
};

it('sends the system prompt and both turns on the messages shape', () => {
  const body = assert<{
    system: { text: string }[];
    messages: { role: string; content: { text?: string }[] }[];
  }>(messagesWire.toBody({ prompt, model: 'm', maxTokens: 8 }));

  expect(body.system.map(part => part.text)).toEqual(['the system prompt']);
  expect(body.messages.map(message => [message.role, message.content[0]?.text])).toEqual([
    ['user', 'the question'],
    ['assistant', 'the answer'],
  ]);
});

it('sends the system prompt as instructions on the responses shape', () => {
  const body = assert<{
    instructions: string;
    input: { role: string; content: { text?: string }[] }[];
  }>(responsesWire.toBody({ prompt, model: 'm', maxTokens: 8 }));

  expect(body.instructions).toBe('the system prompt');
  expect(body.input.map(item => [item.role, item.content[0]?.text])).toEqual([
    ['user', 'the question'],
    ['assistant', 'the answer'],
  ]);
});

it('sends the system prompt as a system message on the completions shape', () => {
  const body = assert<{ messages: { role: string; content: { text?: string }[] }[] }>(
    completionsWire.toBody({ prompt, model: 'm', maxTokens: 8 })
  );

  expect(body.messages.map(message => [message.role, message.content[0]?.text])).toEqual([
    ['system', 'the system prompt'],
    ['user', 'the question'],
    ['assistant', 'the answer'],
  ]);
});
