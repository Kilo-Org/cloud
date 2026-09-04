import { expect, it } from 'vitest';
import type { PromptPart } from '../../../core/prompt.js';
import { completionsWire } from './completions.js';
import { messagesWire } from './messages.js';
import { bodyOf, promptOf } from './render-fixture.js';
import { responsesWire } from './responses.js';

/**
 * How each shape puts a turn's thinking on the wire, and reads it back off.
 *
 * The three do not agree on where thinking lives, what seals it, or whether it
 * can be handed back at all, so each is checked on its own terms. What the
 * session does with the parts is `core/reasoning.test.ts`.
 */

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

it('leaves the reasoning out of the chat shape, which cannot replay it', () => {
  /* Providers relayed through this shape report their thinking under two
     different field names and neither takes it back. This shape carries the
     system prompt as its first message. */
  expect(
    bodyOf(
      completionsWire,
      promptOf([
        { kind: 'reasoning', text: 'first second', signature: 'sig_abc' },
        { kind: 'text', text: 'the answer' },
      ])
    )
  ).toMatchObject({
    messages: [
      { role: 'system' },
      { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
    ],
  });
});

it('replays the thinking of the responses shape as its own item', () => {
  /* This shape does not carry thinking inside a message. It is an item beside
     the message, holding the provider's own encrypted copy, and it goes first
     because that is the order the model produced it in. */
  const seal = JSON.stringify({ id: 'rs_1', encrypted_content: 'ENCRYPTED' });
  const body = bodyOf(
    responsesWire,
    promptOf([
      { kind: 'reasoning', text: 'first second', signature: seal },
      { kind: 'text', text: 'the answer' },
    ])
  );

  expect(body).toMatchObject({
    include: ['reasoning.encrypted_content'],
    input: [
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'ENCRYPTED',
        /* The summary stays empty. The provider sealed the item as it issued
           it, and writing our own words into it would change what it sealed. */
        summary: [],
      },
      { role: 'assistant', content: [{ type: 'input_text', text: 'the answer' }] },
    ],
  });
});

it('leaves out a responses reasoning item the provider never sealed', () => {
  const body = bodyOf(
    responsesWire,
    promptOf([
      { kind: 'reasoning', text: 'unsealed' },
      { kind: 'text', text: 'the answer' },
    ])
  );

  expect(body).toMatchObject({
    input: [{ role: 'assistant', content: [{ type: 'input_text', text: 'the answer' }] }],
  });
});

it('closes a responses reasoning block on the finished item', () => {
  expect(
    responsesWire.toDelta({
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED' },
    })
  ).toEqual({
    kind: 'reasoning',
    text: '',
    signature: JSON.stringify({ id: 'rs_1', encrypted_content: 'ENCRYPTED' }),
  });

  /* A finished message item is not a reasoning item. */
  expect(
    responsesWire.toDelta({
      type: 'response.output_item.done',
      item: { type: 'message', id: 'msg_1' },
    })
  ).toBeUndefined();
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

it('renders an encrypted block as the provider named it', () => {
  const body = bodyOf(
    messagesWire,
    promptOf([
      { kind: 'redacted', data: 'ENCRYPTED' },
      { kind: 'text', text: 'said' },
    ])
  );

  expect(body).toMatchObject({
    messages: [
      {
        content: [
          { type: 'redacted_thinking', data: 'ENCRYPTED' },
          { type: 'text', text: 'said' },
        ],
      },
    ],
  });
});

it('reads an encrypted block off the stream', () => {
  /* It arrives whole, at the start of the block, so there is nothing to
     accumulate and nothing that could be split across two events. */
  expect(
    messagesWire.toDelta({
      type: 'content_block_start',
      content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' },
    })
  ).toEqual({ kind: 'redacted', data: 'ENCRYPTED' });

  /* An ordinary block start must not be read as one. */
  expect(
    messagesWire.toDelta({
      type: 'content_block_start',
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
  ).toBeUndefined();
});

it('leaves an encrypted block out of the two shapes that cannot carry it', () => {
  const parts: readonly PromptPart[] = [
    { kind: 'redacted', data: 'ENCRYPTED' },
    { kind: 'text', text: 'said' },
  ];

  expect(bodyOf(responsesWire, promptOf(parts))).toMatchObject({
    input: [{ content: [{ type: 'input_text', text: 'said' }] }],
  });
  expect(bodyOf(completionsWire, promptOf(parts))).toMatchObject({
    messages: [
      { role: 'system' },
      { role: 'assistant', content: [{ type: 'text', text: 'said' }] },
    ],
  });
});
