import { type Turn } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { asMessages } from './turns';

const turn = (id: string, role: Turn['role'], parts: Turn['parts']): Turn => ({
  id,
  sessionId: 's1',
  role,
  parts,
});

const text = (id: string, body: string) => ({ id, kind: 'text' as const, body });

const drawn = (input: Parameters<typeof asMessages>[0]) =>
  asMessages(input).map(message => ({
    role: message.info.role,
    said: message.parts.map(part => (part.type === 'text' ? part.text : '')).join(''),
  }));

describe('asMessages', () => {
  it('draws the words of each turn, oldest first', () => {
    expect(
      drawn({
        sessionId: 's1',
        model: 'kilo/one',
        turns: [
          turn('t1', 'user', [text('p1', 'what is a monad')]),
          turn('t2', 'assistant', [text('p2', 'a burrito')]),
        ],
        answering: '',
        asked: null,
      })
    ).toEqual([
      { role: 'user', said: 'what is a monad' },
      { role: 'assistant', said: 'a burrito' },
    ]);
  });

  it('leaves out thinking and tool work, and the turns that are only that', () => {
    expect(
      drawn({
        sessionId: 's1',
        model: 'kilo/one',
        turns: [
          turn('t1', 'assistant', [
            { id: 'p1', kind: 'reasoning', body: 'working it out' },
            text('p2', 'a burrito'),
          ]),
          turn('t2', 'assistant', [{ id: 'p3', kind: 'reasoning', body: 'more working' }]),
        ],
        answering: '',
        asked: null,
      })
    ).toEqual([{ role: 'assistant', said: 'a burrito' }]);
  });

  it('puts the unanswered question last, ahead of the answer arriving now', () => {
    expect(
      drawn({
        sessionId: 's1',
        model: 'kilo/one',
        turns: [turn('t1', 'user', [text('p1', 'first')])],
        answering: 'well',
        asked: 'second',
      })
    ).toEqual([
      { role: 'user', said: 'first' },
      { role: 'user', said: 'second' },
      { role: 'assistant', said: 'well' },
    ]);
  });

  it('gives every message its own identifier, so a list can key on it', () => {
    const messages = asMessages({
      sessionId: 's1',
      model: 'kilo/one',
      turns: [turn('t1', 'user', [text('p1', 'first')])],
      answering: 'well',
      asked: 'second',
    });

    expect(new Set(messages.map(message => message.info.id)).size).toBe(messages.length);
  });

  it('names the model the conversation is on', () => {
    const [message] = asMessages({
      sessionId: 's1',
      model: 'kilo/two',
      turns: [turn('t1', 'assistant', [text('p1', 'a burrito')])],
      answering: '',
      asked: null,
    });

    expect(message?.info).toMatchObject({ modelID: 'kilo/two', providerID: 'kilo' });
  });
});
