import { Chunk, Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { completionsWire } from '../plugins/gateway/wire/completions.js';
import { messagesWire } from '../plugins/gateway/wire/messages.js';
import { responsesWire } from '../plugins/gateway/wire/responses.js';
import type { Wire } from '../plugins/gateway/wire/wire.js';
import { assemble } from '../plugins/prompt/default.js';
import type { Prompt, PromptPart } from './prompt.js';
import { run } from './session-fixture.js';

const thinking = {
  deltas: ['the answer'],
  reasoning: ['first', ' second'],
  signature: 'sig_abc',
};

/** What one shape puts on the wire for a prompt, so a test can read the blocks. */
const bodyOf = (wire: Wire, prompt: Prompt): unknown =>
  wire.toBody({ prompt, model: 'm', maxTokens: 8, stream: false });

const promptOf = (parts: readonly PromptPart[]): Prompt => ({
  system: [{ text: 'sys', cache: true }],
  messages: [{ role: 'assistant', parts, cache: false }],
});

it('keeps the reasoning and its signature, ahead of what the model then said', async () => {
  const { value } = await run([thinking], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  const [, answer] = Chunk.toReadonlyArray(value);
  expect(answer?.parts).toMatchObject([
    { kind: 'reasoning', body: 'first second', signature: 'sig_abc' },
    { kind: 'text', body: 'the answer' },
  ]);
});

it('adds no reasoning part when the model did none', async () => {
  const { value } = await run([{ deltas: ['plain'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  expect(Chunk.toReadonlyArray(value)[1]?.parts).toMatchObject([{ kind: 'text', body: 'plain' }]);
});

it('keeps a thinking block that carries a signature and no words', async () => {
  /* A provider returns the thinking as a summary, and defaults to no summary
     at all. The block is then empty, is still billed, and still has to go back
     exactly as it came. Dropping it here would drop every block on that
     default. */
  const { value } = await run([{ deltas: ['said'], signature: 'sig_empty' }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('why')), session.history)
  );

  expect(Chunk.toReadonlyArray(value)[1]?.parts).toMatchObject([
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

it('renders the thinking block the way the provider issued it', () => {
  const body = bodyOf(
    messagesWire,
    promptOf([
      { kind: 'reasoning', text: 'first second', signature: 'sig_abc' },
      { kind: 'text', text: 'the answer' },
    ])
  );

  expect(body).toMatchObject({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first second', signature: 'sig_abc' },
          { type: 'text', text: 'the answer' },
        ],
      },
    ],
  });
});

it('leaves out a thinking block that has no signature', () => {
  /* The provider refuses a block whose signature is missing, so a shape that
     cannot prove the thinking is the model's own says nothing rather than
     sending it and being refused. */
  const body = bodyOf(
    messagesWire,
    promptOf([
      { kind: 'reasoning', text: 'unsigned' },
      { kind: 'text', text: 'the answer' },
    ])
  );

  expect(body).toMatchObject({
    messages: [{ content: [{ type: 'text', text: 'the answer' }] }],
  });
});

it('leaves the reasoning out of the two shapes that cannot replay it', () => {
  const parts: readonly PromptPart[] = [
    { kind: 'reasoning', text: 'first second', signature: 'sig_abc' },
    { kind: 'text', text: 'the answer' },
  ];

  /* The responses shape replays thinking as an encrypted reasoning item the
     request has to ask for, and the chat shape has no replay at all. */
  expect(bodyOf(responsesWire, promptOf(parts))).toMatchObject({
    input: [{ content: [{ type: 'input_text', text: 'the answer' }] }],
  });
  /* This shape carries the system prompt as its first message. */
  expect(bodyOf(completionsWire, promptOf(parts))).toMatchObject({
    messages: [
      { role: 'system' },
      { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
    ],
  });
});

it('streams the reasoning to the caller, marked as reasoning', async () => {
  const { value } = await run([thinking], session => Stream.runCollect(session.ask('why')));

  expect(
    Chunk.toReadonlyArray(value)
      .filter(event => event.kind === 'reasoning')
      .map(event => event.text)
  ).toEqual(['first', ' second', '']);
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

  /* The signature closes the block and arrives with no thinking on it. */
  expect(messagesWire.toDelta({ delta: { signature: 'sig_abc' } })).toEqual({
    kind: 'reasoning',
    text: '',
    signature: 'sig_abc',
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
