import { describe, expect, it } from 'vitest';
import { kilo2MessageSchema } from '../shared/kilo2-conversation.js';
import { readKilo2Answer, readV1Answer } from './assistant-answer.js';

describe('callback answers from native messages', () => {
  it('reads v1 text and tool statuses, without reasoning or tool contents', () => {
    expect(
      readV1Answer([
        { id: 'p1', messageID: 'm', type: 'reasoning', text: 'private reasoning' },
        { id: 'p2', messageID: 'm', type: 'text', text: 'Checking ' },
        {
          id: 'p3',
          messageID: 'm',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: 'private', output: 'private' },
        },
        { id: 'p4', messageID: 'm', type: 'tool', tool: 'bad', state: { status: 'private' } },
        { id: 'p5', messageID: 'm', type: 'text', text: 'the build' },
      ])
    ).toEqual({ text: 'Checking the build', tools: [{ name: 'bash', status: 'completed' }] });
  });

  it('reads v2 content in message order, with native tool names and statuses', () => {
    const message = kilo2MessageSchema.parse({
      id: 'msg_assistant',
      type: 'assistant',
      time: { created: 1 },
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'before ' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'shell',
          state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'private' }] },
        },
        { type: 'tool', id: 'call_2', name: 'read', state: { status: 'streaming', input: '' } },
        { type: 'text', text: 'after' },
      ],
    });
    expect(readKilo2Answer(message)).toEqual({
      text: 'before after',
      tools: [
        { name: 'shell', status: 'completed' },
        { name: 'read', status: 'pending' },
      ],
    });
  });
});
