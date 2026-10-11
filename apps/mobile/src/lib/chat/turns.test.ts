import { type Turn } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { getMessageDetailsContent } from '@/components/agents/message-details-content';

import { askedMessageId, asMessages } from './turns';

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
        turns: [
          turn('t1', 'user', [text('p1', 'what is a monad')]),
          turn('t2', 'assistant', [text('p2', 'a burrito')]),
        ],
        answering: '',
        asked: null,
        askedImages: [],
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
        turns: [
          turn('t1', 'assistant', [
            { id: 'p1', kind: 'reasoning', body: 'working it out' },
            text('p2', 'a burrito'),
          ]),
          turn('t2', 'assistant', [{ id: 'p3', kind: 'reasoning', body: 'more working' }]),
        ],
        answering: '',
        asked: null,
        askedImages: [],
        waiting: [],
      })
    ).toEqual([{ role: 'assistant', said: 'a burrito' }]);
  });

  it('puts the unanswered question last, ahead of the answer arriving now', () => {
    expect(
      drawn({
        sessionId: 's1',
        turns: [turn('t1', 'user', [text('p1', 'first')])],
        answering: 'well',
        asked: 'second',
        askedImages: [],
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
      turns: [turn('t1', 'user', [text('p1', 'first')])],
      answering: 'well',
      asked: 'second',
      askedImages: [],
      waiting: [],
    });

    expect(new Set(messages.map(message => message.info.id)).size).toBe(messages.length);
  });

  it('shows the question while its answer is still arriving', () => {
    expect(
      drawn({
        sessionId: 's1',
        turns: [],
        answering: 'a bur',
        asked: 'what is a monad',
        askedImages: [],
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
        turns: [],
        answering: 'a bur',
        asked: 'what is a monad',
        askedImages: [],
        waiting: [
          { text: 'and a functor', images: [] },
          { text: 'and a natural transformation', images: [] },
        ],
      })
    ).toEqual([
      { role: 'user', said: 'what is a monad' },
      { role: 'assistant', said: 'a bur' },
      { role: 'user', said: 'and a functor' },
      { role: 'user', said: 'and a natural transformation' },
    ]);
  });

  it('marks the unanswered question with the identifier its Retry hangs off', () => {
    const messages = asMessages({
      sessionId: 's1',
      turns: [],
      answering: '',
      asked: 'what is a monad',
      askedImages: [],
      waiting: [{ text: 'and a functor', images: [] }],
    });

    expect(messages.map(message => message.info.id)).toEqual([
      askedMessageId('s1'),
      's1:waiting:0',
    ]);
  });

  it('names no model and no time, so the details sheet leaves those rows out', () => {
    const messages = asMessages({
      sessionId: 's1',
      turns: [
        turn('t1', 'user', [text('p1', 'what is a monad')]),
        turn('t2', 'assistant', [text('p2', 'a burrito')]),
      ],
      answering: '',
      asked: null,
      askedImages: [],
      waiting: [],
    });

    for (const message of messages) {
      expect(getMessageDetailsContent(message, [])).toMatchObject({
        sentTimeLabel: null,
        modelLabel: null,
        costLabel: null,
        tokenRows: null,
        copyText: message.info.role === 'user' ? 'what is a monad' : 'a burrito',
      });
    }
  });

  it('draws a stored image as a file part the bubble shows', () => {
    const [message] = asMessages({
      sessionId: 's1',
      turns: [
        turn('t1', 'user', [
          { id: 'p1', kind: 'image', media: 'image/jpeg', body: 'AAAA' },
          text('p2', 'what is this'),
        ]),
      ],
      answering: '',
      asked: null,
      askedImages: [],
      waiting: [],
    });

    expect(message?.parts).toEqual([
      {
        id: 'p1',
        sessionID: 's1',
        messageID: 't1',
        type: 'file',
        mime: 'image/jpeg',
        url: 'data:image/jpeg;base64,AAAA',
      },
      expect.objectContaining({ type: 'text', text: 'what is this' }),
    ]);
  });

  it('draws a turn that is only an image', () => {
    expect(
      asMessages({
        sessionId: 's1',
        turns: [turn('t1', 'user', [{ id: 'p1', kind: 'image', media: 'image/png', body: 'AA' }])],
        answering: '',
        asked: null,
        askedImages: [],
        waiting: [],
      })
    ).toHaveLength(1);
  });

  it('shows the images of the unanswered and waiting questions ahead of their words', () => {
    const image = { media: 'image/jpeg', data: 'BBBB' };
    const messages = asMessages({
      sessionId: 's1',
      turns: [],
      answering: '',
      asked: 'look',
      askedImages: [image],
      waiting: [{ text: '', images: [image] }],
    });

    expect(messages.map(message => message.parts.map(part => part.type))).toEqual([
      ['file', 'text'],
      ['file'],
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ url: 'data:image/jpeg;base64,BBBB' });
  });
});
