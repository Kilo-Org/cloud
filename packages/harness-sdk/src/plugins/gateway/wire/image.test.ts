import { assert } from 'typia';
import { expect, it } from 'vitest';
import type { ModelRequest } from '../../../core/model.js';
import type { Prompt } from '../../../core/prompt.js';
import { completionsWire } from './completions.js';
import { messagesWire } from './messages.js';
import { responsesWire } from './responses.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE';

const promptWith = (media: string): Prompt => ({
  system: [{ text: 'sys', cache: true }],
  messages: [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'what is this' },
        { kind: 'image', media, data: pixel },
      ],
      cache: true,
    },
  ],
});

const request = (media: string): ModelRequest => ({
  prompt: promptWith(media),
  model: 'claude-opus-5',
  maxTokens: 64,
  stream: false,
  cacheKey: 'ses_1',
});

it('sends the image as base64 the provider can read, without encoding it again', () => {
  const body = messagesWire.toBody(request('image/png'));

  expect(body).toMatchObject({
    messages: [
      {
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } },
        ],
      },
    ],
  });
});

it('marks the breakpoint on the last block of the message, not on every one', () => {
  const body = assert<{ messages: { content: { cache_control?: unknown }[] }[] }>(
    messagesWire.toBody(request('image/png'))
  );

  /* A breakpoint on the text block would cut the prefix before the image, so
     the image would be paid for on every single request of the session. */
  const marks = body.messages[0]?.content.map(block => block.cache_control !== undefined);
  expect(marks).toEqual([false, true]);
});

it('refuses a media type the shape cannot carry rather than sending it', () => {
  expect(() => messagesWire.toBody(request('image/heic'))).toThrow();
});

it('sends the image as a data URI on both OpenAI shapes', () => {
  const uri = `data:image/png;base64,${pixel}`;

  expect(responsesWire.toBody(request('image/png'))).toMatchObject({
    input: [{ content: [{ type: 'input_text' }, { type: 'input_image', image_url: uri }] }],
  });
  expect(completionsWire.toBody(request('image/png'))).toMatchObject({
    messages: [
      { role: 'system' },
      { content: [{ type: 'text' }, { type: 'image_url', image_url: { url: uri } }] },
    ],
  });
});
