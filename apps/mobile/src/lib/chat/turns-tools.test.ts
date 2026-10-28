import { type Turn } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { answerParts } from './answer-parts';
import { askedMessageId, asMessages } from './turns';

const turn = (id: string, role: Turn['role'], parts: Turn['parts']): Turn => ({
  id,
  sessionId: 's1',
  role,
  parts,
});

const text = (id: string, body: string) => ({ id, kind: 'text' as const, body });

describe('tool turns', () => {
  it.each(['time', 'mcp_kilo_search', 'web_search'])(
    'reopens %s through one shared tool part with inspectable arguments and output',
    name => {
      const messages = asMessages({
        sessionId: 's1',
        turns: [
          turn('t1', 'assistant', [
            text('p1', 'Checking.'),
            { id: 'p2', kind: 'toolCall', callId: 'c1', name, body: '{"query":"today"}' },
          ]),
          turn('t2', 'user', [
            { id: 'p3', kind: 'toolResult', callId: 'c1', body: 'the result', failed: false },
          ]),
          turn('t3', 'assistant', [text('p4', 'The answer.')]),
        ],
        answering: [],
        asked: null,
        askedImages: [],
        waiting: [],
      });
      expect(messages.map(message => message.info.id)).toEqual(['t1', 't3']);
      expect(messages[0]?.parts.map(part => part.type)).toEqual(['text', 'tool']);
      expect(messages[0]?.parts[1]).toMatchObject({
        id: 'p2',
        type: 'tool',
        tool: name,
        callID: 'c1',
        state: { status: 'completed', input: { query: 'today' }, output: 'the result' },
      });
    }
  );

  it('keeps tool-only turns but omits result-only, empty-text and reasoning-only bubbles', () => {
    const messages = asMessages({
      sessionId: 's1',
      turns: [
        turn('t1', 'assistant', [
          { id: 'p1', kind: 'reasoning', body: 'use the clock' },
          text('p2', ''),
          { id: 'p3', kind: 'toolCall', callId: 'c1', name: 'time', body: '{}' },
        ]),
        turn('t2', 'user', [
          { id: 'p4', kind: 'toolResult', callId: 'c1', body: 'clock unavailable', failed: true },
        ]),
        turn('t3', 'assistant', [text('p5', '')]),
      ],
      answering: [],
      asked: null,
      askedImages: [],
      waiting: [],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map(part => part.type)).toEqual(['reasoning', 'tool']);
    expect(messages[0]?.parts[1]).toMatchObject({
      state: { status: 'error', input: {}, error: 'clock unavailable' },
    });
  });

  it('matches reused call ids to their own results without changing text/tool order', () => {
    const messages = asMessages({
      sessionId: 's1',
      turns: [
        turn('t1', 'assistant', [
          { id: 'p1', kind: 'toolCall', callId: 'c1', name: 'time', body: '{}' },
          text('p2', 'first'),
        ]),
        turn('t2', 'user', [
          { id: 'p3', kind: 'toolResult', callId: 'c1', body: 'first result', failed: false },
        ]),
        turn('t3', 'assistant', [
          text('p4', 'second'),
          { id: 'p5', kind: 'toolCall', callId: 'c1', name: 'time', body: '{}' },
        ]),
        turn('t4', 'user', [
          { id: 'p6', kind: 'toolResult', callId: 'c1', body: 'second result', failed: false },
        ]),
      ],
      answering: [],
      asked: null,
      askedImages: [],
      waiting: [],
    });
    expect(messages.map(message => message.parts.map(part => part.type))).toEqual([
      ['tool', 'text'],
      ['text', 'tool'],
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ state: { output: 'first result' } });
    expect(messages[1]?.parts[1]).toMatchObject({ state: { output: 'second result' } });
  });

  it('shows a live tool-only answer ahead of queued questions without an empty text bubble', () => {
    const messages = asMessages({
      sessionId: 's1',
      turns: [],
      answering: answerParts({
        sessionId: 's1',
        parts: [],
        event: { kind: 'toolCall', call: { id: 'c1', name: 'time', arguments: '{}' } },
        now: 1,
      }),
      asked: 'what time is it',
      askedImages: [],
      waiting: [{ text: 'and tomorrow', images: [] }],
    });
    expect(messages.map(message => message.info.id)).toEqual([
      askedMessageId('s1'),
      's1:answering',
      's1:waiting:0',
    ]);
    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({
        type: 'tool',
        state: expect.objectContaining({ status: 'pending' }),
      }),
    ]);
  });
});
