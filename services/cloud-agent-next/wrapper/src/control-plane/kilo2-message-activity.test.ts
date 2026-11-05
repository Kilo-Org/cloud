import { describe, expect, it } from 'bun:test';
import { kilo2MessageSchema } from './kilo2-api.js';
import { kilo2MessageActivity, kilo2PartId } from './kilo2-message-activity.js';

const parse = (value: unknown) => kilo2MessageSchema.parse(value);

describe('Kilo v2 message activity', () => {
  it('addresses text by per-kind ordinal, as the text events do', () => {
    const message = parse({
      id: 'msg_answer',
      type: 'assistant',
      time: { created: 2 },
      content: [
        { type: 'text', id: 'native-text-id', text: 'before' },
        { type: 'reasoning', text: 'thinking' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'shell',
          state: {
            status: 'completed',
            input: {},
            content: [
              { type: 'text', text: 'one' },
              { type: 'text', text: 'two' },
            ],
          },
        },
        { type: 'text', text: 'after' },
      ],
    });
    const activity = kilo2MessageActivity('ses_local', message);
    expect(activity?.parts.map(part => part.id)).toEqual([
      kilo2PartId('msg_answer', 'text', 0),
      kilo2PartId('msg_answer', 'reasoning', 0),
      kilo2PartId('msg_answer', 'tool', 'call_1'),
      kilo2PartId('msg_answer', 'text', 1),
    ]);
    expect(activity?.parts[2].tool).toEqual({
      callId: 'call_1',
      name: 'shell',
      status: 'completed',
      interactive: false,
      output: 'one\ntwo',
    });
  });

  it('reports a streaming tool as pending, a subagent child, and a tool error', () => {
    const activity = kilo2MessageActivity(
      'ses_local',
      parse({
        id: 'msg_tools',
        type: 'assistant',
        time: { created: 2 },
        error: { type: 'provider', message: 'overloaded' },
        content: [
          {
            type: 'tool',
            id: 'call_stream',
            name: 'edit',
            state: { status: 'streaming', input: '{' },
          },
          {
            type: 'tool',
            id: 'call_child',
            name: 'subagent',
            state: { status: 'running', input: {}, metadata: { sessionID: 'ses_child' } },
          },
          {
            type: 'tool',
            id: 'call_ask',
            name: 'question',
            state: { status: 'running', input: {} },
          },
          {
            type: 'tool',
            id: 'call_fail',
            name: 'shell',
            state: { status: 'error', input: {}, error: { type: 'tool', message: 'denied' } },
          },
        ],
      })
    );
    expect(activity?.error).toEqual({ type: 'provider', message: 'overloaded' });
    expect(activity?.parts.map(part => part.tool)).toEqual([
      { callId: 'call_stream', name: 'edit', status: 'pending', interactive: false },
      {
        callId: 'call_child',
        name: 'subagent',
        status: 'running',
        interactive: false,
        childSessionId: 'ses_child',
      },
      { callId: 'call_ask', name: 'question', status: 'running', interactive: true },
      { callId: 'call_fail', name: 'shell', status: 'error', interactive: false, error: 'denied' },
    ]);
  });

  it('reads prompts as user messages and only completed compactions as model work', () => {
    expect(
      kilo2MessageActivity(
        'ses_local',
        parse({ id: 'msg_prompt', type: 'synthetic', text: 'continue', time: { created: 1 } })
      )
    ).toEqual({
      sessionId: 'ses_local',
      id: 'msg_prompt',
      role: 'user',
      time: { created: 1 },
      parts: [],
    });
    const compaction = (status: string) =>
      kilo2MessageActivity(
        'ses_local',
        parse({
          id: 'msg_compact',
          type: 'compaction',
          status,
          summary: 'short',
          time: { created: 3 },
        })
      );
    expect(compaction('running')).toBeUndefined();
    expect(compaction('completed')).toMatchObject({
      role: 'assistant',
      time: { created: 3, completed: 3 },
      parts: [{ id: kilo2PartId('msg_compact', 'text', 0), kind: 'text', text: 'short' }],
    });
    expect(
      kilo2MessageActivity(
        'ses_local',
        parse({ id: 'msg_note', type: 'note', time: { created: 4 } })
      )
    ).toBeUndefined();
  });
});
