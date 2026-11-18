import { describe, expect, it } from 'bun:test';
import { kiloActivity, kiloSnapshotMessage } from './kilo-message-activity.js';

describe('Kilo v1 message activity', () => {
  it('reads messages, parts and text deltas from message events', () => {
    expect(
      kiloActivity('message.updated', {
        info: {
          id: 'msg_1',
          sessionID: 'ses_1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          error: { name: 'APIError' },
        },
      })
    ).toEqual([
      {
        type: 'message',
        message: {
          sessionId: 'ses_1',
          id: 'msg_1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          error: { name: 'APIError' },
        },
      },
    ]);
    expect(
      kiloActivity('message.part.delta', {
        sessionID: 'ses_1',
        messageID: 'msg_1',
        partID: 'prt_1',
        field: 'text',
        delta: 'hi',
      })
    ).toEqual([
      { type: 'delta', sessionId: 'ses_1', messageId: 'msg_1', partId: 'prt_1', text: 'hi' },
    ]);
    expect(
      kiloActivity('message.part.delta', {
        sessionID: 'ses_1',
        messageID: 'msg_1',
        partID: 'prt_1',
        field: 'state',
        delta: 'x',
      })
    ).toEqual([]);
    expect(
      kiloActivity('session.status', { sessionID: 'ses_1', status: { type: 'busy' } })
    ).toEqual([]);
  });

  it('reads tool output, interactive tools and task children', () => {
    const tool = (name: string, state: Record<string, unknown>) =>
      kiloActivity('message.part.updated', {
        part: {
          id: `prt_${name}`,
          messageID: 'msg_1',
          sessionID: 'ses_1',
          type: 'tool',
          callID: `call_${name}`,
          tool: name,
          state,
        },
      })[0];
    expect(tool('bash', { status: 'running', metadata: { output: 'partial' } })).toEqual({
      type: 'part',
      part: {
        sessionId: 'ses_1',
        messageId: 'msg_1',
        id: 'prt_bash',
        kind: 'tool',
        tool: {
          callId: 'call_bash',
          name: 'bash',
          status: 'running',
          interactive: false,
          output: 'partial',
        },
      },
    });
    expect(tool('question', { status: 'running' })).toMatchObject({
      part: { tool: { interactive: true } },
    });
    expect(tool('task', { status: 'running', metadata: { sessionId: 'ses_child' } })).toMatchObject(
      {
        part: { tool: { childSessionId: 'ses_child' } },
      }
    );
    expect(tool('edit', { status: 'error', error: 'denied' })).toMatchObject({
      part: { tool: { status: 'error', error: 'denied' } },
    });
  });

  it('maps a message read with its supported parts', () => {
    expect(
      kiloSnapshotMessage({
        info: { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'prt_text', messageID: 'msg_1', type: 'text', text: 'hello' },
          { id: 'prt_step', messageID: 'msg_1', type: 'step-start' },
        ],
      })
    ).toEqual({
      sessionId: 'ses_1',
      id: 'msg_1',
      role: 'assistant',
      time: { created: 1 },
      parts: [
        { sessionId: 'ses_1', messageId: 'msg_1', id: 'prt_text', kind: 'text', text: 'hello' },
      ],
    });
  });
});
