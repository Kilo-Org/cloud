import { type PulledMessage } from '@kilocode/cloud-agent-sdk';
import { type Turn } from '@kilocode/harness-sdk';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';

import { msgIdForTurn } from './sync-ids';
import {
  imagePartsOf,
  portableModelRef,
  pulledToTurns,
  type SequencedTurn,
  tailStateOf,
  turnsToPortable,
} from './sync-mapping';

const nextId = monotonicFactory();
const turnId = () => `trn_${nextId()}`;
const partId = () => `prt_${nextId()}`;

const userTurn = (parts: Turn['parts']): Turn => ({
  id: turnId(),
  sessionId: 'ses_local',
  role: 'user',
  parts,
});
const assistantTurn = (parts: Turn['parts']): Turn => ({
  id: turnId(),
  sessionId: 'ses_local',
  role: 'assistant',
  parts,
});

const sequence = (turns: readonly Turn[]): SequencedTurn[] =>
  turns.map((turn, index) => ({ turn, seq: index + 1, msgId: msgIdForTurn(turn.id) }));

const MODEL = { providerID: 'kilo', id: 'kilo/test' };

describe('turnsToPortable', () => {
  it('maps user text and assistant text, then settles with idle', () => {
    const turns = [
      userTurn([{ id: partId(), kind: 'text', body: 'hello' }]),
      assistantTurn([{ id: partId(), kind: 'text', body: 'hi' }]),
    ];
    const messages = turnsToPortable(sequence(turns), {
      model: MODEL,
      agent: 'kilo',
      blobs: new Map(),
      idleSeq: 3,
      now: 5000,
    });
    expect(messages.map(one => one.type)).toEqual(['user', 'assistant', 'idle']);
    expect(messages[0]).toMatchObject({ text: 'hello', seq: 1 });
    expect(messages[1]).toMatchObject({ seq: 2, model: MODEL });
    expect(messages[2]).toMatchObject({ seq: 3, outcome: 'succeeded' });
  });

  it('folds a tool result turn into the assistant tool content by callId', () => {
    const call = assistantTurn([
      { id: partId(), kind: 'toolCall', body: '{"q":"weather"}', callId: 'call_1', name: 'search' },
    ]);
    const results = userTurn([
      { id: partId(), kind: 'toolResult', body: 'sunny', callId: 'call_1', failed: false },
    ]);
    const answer = assistantTurn([{ id: partId(), kind: 'text', body: 'It is sunny' }]);
    const messages = turnsToPortable(sequence([call, results, answer]), {
      model: MODEL,
      agent: 'kilo',
      blobs: new Map(),
      idleSeq: null,
      now: 5000,
    });
    // The results turn holds no words of its own: no user message for it.
    expect(messages.map(one => one.type)).toEqual(['assistant', 'assistant']);
    const first = messages[0];
    expect(first?.type).toBe('assistant');
    if (first?.type === 'assistant') {
      expect(first.content[0]).toMatchObject({
        type: 'tool',
        id: 'call_1',
        name: 'search',
        state: {
          status: 'completed',
          input: { q: 'weather' },
          content: [{ type: 'text', text: 'sunny' }],
        },
      });
    }
  });

  it('marks a failed tool result as error and carries reasoning', () => {
    const call = assistantTurn([
      { id: partId(), kind: 'reasoning', body: 'thinking' },
      { id: partId(), kind: 'toolCall', body: '{}', callId: 'call_2', name: 'broken' },
    ]);
    const results = userTurn([
      { id: partId(), kind: 'toolResult', body: 'boom', callId: 'call_2', failed: true },
    ]);
    const [message] = turnsToPortable(sequence([call, results]), {
      model: MODEL,
      agent: 'kilo',
      blobs: new Map(),
      idleSeq: null,
      now: 5000,
    });
    expect(message?.type).toBe('assistant');
    if (message?.type === 'assistant') {
      expect(message.content[0]).toEqual({ type: 'reasoning', text: 'thinking' });
      expect(message.content[1]).toMatchObject({ type: 'tool', state: { status: 'error' } });
    }
  });

  it('attaches uploaded image blobs and lists image parts for the engine', () => {
    const image = { id: partId(), kind: 'image' as const, body: 'aGk=', media: 'image/png' };
    const turns = [userTurn([{ id: partId(), kind: 'text', body: 'look' }, image])];
    expect(imagePartsOf(turns)).toEqual([{ partId: image.id, media: 'image/png', base64: 'aGk=' }]);
    const [message] = turnsToPortable(sequence(turns), {
      model: MODEL,
      agent: 'kilo',
      blobs: new Map([[image.id, { hash: 'abc', bytes: 2 }]]),
      idleSeq: null,
      now: 5000,
    });
    expect(message).toMatchObject({
      type: 'user',
      files: [{ mime: 'image/png', blob: { hash: 'abc', bytes: 2 } }],
    });
  });
});

describe('portableModelRef', () => {
  it('records gateway, on-device and custom models under their providers', () => {
    expect(portableModelRef('anthropic/claude-x')).toEqual({
      providerID: 'kilo',
      id: 'anthropic/claude-x',
    });
    expect(portableModelRef('gguf:llama').providerID).toBe('kilo-mobile-local');
    expect(portableModelRef('backend:mine').providerID).toBe('kilo-mobile-custom');
  });
});

const pulled = (over: Partial<PulledMessage['message']>, seq: number): PulledMessage => ({
  seq,
  sourceID: 'source-cli',
  message: {
    id: `msg_pulled${seq}`,
    type: 'user',
    time: { created: 1000 + seq },
    ...over,
  },
});

describe('pulledToTurns', () => {
  it('imports user and assistant messages in seq order, tools split back out', () => {
    const turns = pulledToTurns(
      [
        pulled({ type: 'assistant', content: [{ type: 'text', text: 'done' }] }, 3),
        pulled({ text: 'question' }, 1),
        pulled(
          {
            type: 'assistant',
            time: { created: 1002, completed: 1003 },
            content: [
              {
                type: 'tool',
                id: 'call_9',
                name: 'read',
                state: {
                  status: 'completed',
                  input: { path: 'a.ts' },
                  content: [{ type: 'text', text: 'contents' }],
                },
              },
            ],
          },
          2
        ),
        pulled({ type: 'idle' }, 4),
      ],
      'ses_server'
    );
    expect(turns.map(one => one.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: 'text', body: 'question' });
    expect(turns[1]?.parts[0]).toMatchObject({ kind: 'toolCall', callId: 'call_9', name: 'read' });
    expect(turns[2]?.parts[0]).toMatchObject({
      kind: 'toolResult',
      callId: 'call_9',
      body: 'contents',
      failed: false,
    });
    // Local order equals seq order: ids sort the way the turns list.
    const ids = turns.map(one => one.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('imports an inline image file as an image part', () => {
    const turns = pulledToTurns(
      [
        pulled(
          {
            text: 'see',
            files: [{ mime: 'image/png', data: 'aGk=', source: { type: 'inline' } }],
          },
          1
        ),
      ],
      'ses_server'
    );
    expect(turns[0]?.parts.map(part => part.kind)).toEqual(['text', 'image']);
  });
});

describe('tailStateOf', () => {
  it('settles on idle, user and completed tails; a fresh unfinished assistant is busy', () => {
    const now = 10_000_000;
    expect(tailStateOf([], now)).toEqual({ kind: 'empty' });
    expect(tailStateOf([pulled({ type: 'idle' }, 1)], now).kind).toBe('settled');
    expect(tailStateOf([pulled({ text: 'q' }, 1)], now).kind).toBe('settled');
    expect(
      tailStateOf(
        [pulled({ type: 'assistant', time: { created: now - 1000, completed: now - 500 } }, 1)],
        now
      ).kind
    ).toBe('settled');
    expect(
      tailStateOf([pulled({ type: 'assistant', time: { created: now - 1000 } }, 1)], now).kind
    ).toBe('busy');
    // A stale unfinished tail counts as interrupted, so a turn may start.
    expect(
      tailStateOf([pulled({ type: 'assistant', time: { created: now - 11 * 60 * 1000 } }, 1)], now)
        .kind
    ).toBe('settled');
  });
});
