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
        waiting: [],
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
        waiting: [],
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
        waiting: [],
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
      waiting: [],
    });

    expect(new Set(messages.map(message => message.info.id)).size).toBe(messages.length);
  });

  it('shows the question while its answer is still arriving', () => {
    expect(
      drawn({
        sessionId: 's1',
        model: 'kilo/one',
        turns: [],
        answering: 'a bur',
        asked: 'what is a monad',
        waiting: [],
      })
    ).toEqual([
      { role: 'user', said: 'what is a monad' },
      { role: 'assistant', said: 'a bur' },
    ]);
  });

  it('draws what was typed while the answer arrived, in the order it will be asked', () => {
    expect(
      drawn({
        sessionId: 's1',
        model: 'kilo/one',
        turns: [],
        answering: 'a bur',
        asked: 'what is a monad',
        waiting: ['and a functor', 'and a natural transformation'],
      })
    ).toEqual([
      { role: 'user', said: 'what is a monad' },
      { role: 'assistant', said: 'a bur' },
      { role: 'user', said: 'and a functor' },
      { role: 'user', said: 'and a natural transformation' },
    ]);
  });

  it('names the model the conversation is on', () => {
    const [message] = asMessages({
      sessionId: 's1',
      model: 'kilo/two',
      turns: [turn('t1', 'assistant', [text('p1', 'a burrito')])],
      answering: '',
      asked: null,
      waiting: [],
    });

    expect(message?.info).toMatchObject({ modelID: 'kilo/two', providerID: 'kilo' });
  });
});
