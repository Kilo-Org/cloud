import { z } from 'zod';
import { kilo2MessageSchema } from '@kilocode/session-ingest-contracts';
import { applyNativeEvent, projectNativeEvent } from './native-conversation-reducer';
import type { NativeEvent } from './native-sync';
import type { NativeSnapshotMessage } from './native-sync-snapshot';

// The validated delta path this projection used to run for every fragment, kept here as the
// oracle: a fast path may skip re-validating stored values, but never change their values.
const recordSchema = z.record(z.string(), z.unknown());
const messageSchema = z.intersection(kilo2MessageSchema, recordSchema);
const contentPartSchema = z.intersection(
  kilo2MessageSchema.shape.content.unwrap().element,
  recordSchema
);

function referenceDelta(
  entry: NativeSnapshotMessage,
  kind: 'text' | 'reasoning',
  ordinal: number,
  delta: string,
  created: number,
  native: unknown
): NativeSnapshotMessage {
  const content = [...(entry.message.content ?? [])];
  let index: number | undefined;
  let seen = 0;
  for (let position = 0; position < content.length; position++) {
    if (content[position]?.type === kind && seen++ === ordinal) {
      index = position;
      break;
    }
  }
  if (index === undefined) {
    if (ordinal !== seen) return { ...entry, incomplete: true };
    index = content.length;
    content.push({
      type: kind,
      text: '',
      ...(kind === 'reasoning' ? { time: { created }, native } : {}),
    });
  }
  const previous = content[index];
  if (!previous) return entry;
  content[index] = contentPartSchema.parse({ ...previous, text: `${previous.text ?? ''}${delta}` });
  const validated = messageSchema.parse({ ...entry.message, content });
  validated.content = content;
  return { ...entry, message: validated };
}

function frame(type: string, data: Record<string, unknown>, seq: number): NativeEvent {
  return {
    v: 1,
    channel: 'events',
    seq,
    from: 'runner',
    at: seq + 100,
    type,
    body: {
      syncPosition: seq,
      data: {
        id: `evt_${seq}`,
        created: seq,
        type,
        metadata: { trace: { retained: true } },
        data: { sessionID: 'ses_native', ...data },
      },
    },
  };
}

const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } };
const other: NativeSnapshotMessage = {
  seq: 1,
  message: { id: 'msg_other', type: 'user', text: 'unrelated', time: { created: 2 } },
};

/** Pseudo-random but reproducible, so a failing sequence stays reportable. */
function random(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

function startAnswer(messages: NativeSnapshotMessage[], seq: number) {
  const projection = projectNativeEvent(
    messages,
    frame(
      'session.step.started',
      {
        assistantMessageID: 'msg_answer',
        started: seq,
        agent: 'plan',
        model: { providerID: 'vendor', id: 'model', variant: 'high' },
      },
      seq
    )
  );
  expect(projection.changed).toBeUndefined();
  return projection.messages;
}

test('every delta entry equals the validated reference over a randomized text, reasoning and tool sequence', () => {
  const next = random(20261122);
  const chunks = ['a', 'b', ' ', 'word', '\n', '…', '].', ''];
  let messages = startAnswer([other], 10);
  expect(messages).toHaveLength(2);
  expect(messages[1]?.message.id).toBe('msg_answer');
  let seq = 11;
  messages = applyNativeEvent(
    messages,
    frame('session.text.started', { assistantMessageID: 'msg_answer', ordinal: 0 }, seq++)
  );
  messages = applyNativeEvent(
    messages,
    frame('session.reasoning.started', { assistantMessageID: 'msg_answer', ordinal: 0 }, seq++)
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.tool.input.started',
      { assistantMessageID: 'msg_answer', id: 'call', name: 'shell' },
      seq++
    )
  );
  let deltas = 0;
  for (let step = 0; step < 240; step++) {
    const previous = messages[1];
    if (!previous) throw new Error('Missing projected answer');
    const roll = next();
    let event: NativeEvent;
    let expected: NativeSnapshotMessage | undefined;
    if (roll < 0.55) {
      const delta = chunks[Math.floor(next() * chunks.length)] ?? 'x';
      const created = seq++;
      event = frame(
        'session.text.delta',
        { assistantMessageID: 'msg_answer', ordinal: 0, delta },
        created
      );
      expected = referenceDelta(previous, 'text', 0, delta, created, undefined);
    } else if (roll < 0.8) {
      const delta = chunks[Math.floor(next() * chunks.length)] ?? 'y';
      const created = seq++;
      event = frame(
        'session.reasoning.delta',
        { assistantMessageID: 'msg_answer', ordinal: 0, delta },
        created
      );
      expected = referenceDelta(previous, 'reasoning', 0, delta, created, undefined);
    } else if (roll < 0.9) {
      const delta = chunks[Math.floor(next() * chunks.length)] ?? 'z';
      event = frame(
        'session.tool.input.delta',
        { assistantMessageID: 'msg_answer', id: 'call', delta },
        seq++
      );
    } else {
      event = frame(
        'session.text.ended',
        { assistantMessageID: 'msg_answer', ordinal: 0, text: 'final text' },
        seq++
      );
    }
    const projection = projectNativeEvent(messages, event);
    if (expected) {
      deltas++;
      expect(projection.changed).toHaveLength(1);
      expect(projection.changed?.[0]).toEqual(expected);
      expect(projection.messages[1]).toBe(projection.changed?.[0]);
    }
    // The unrelated message never moves, whichever frame runs.
    expect(projection.messages[0]).toBe(other);
    messages = projection.messages;
  }
  expect(deltas).toBeGreaterThan(40);
});

test('a long accumulated part keeps the delta entry equal to the reference', () => {
  let messages = startAnswer([other], 1);
  messages = applyNativeEvent(
    messages,
    frame('session.text.started', { assistantMessageID: 'msg_answer', ordinal: 0 }, 2)
  );
  let seq = 3;
  let long = '';
  for (let index = 0; index < 40; index++) {
    const delta = `chunk-${index};`.repeat(4);
    long += delta;
    const previous = messages[1];
    if (!previous) throw new Error('Missing projected answer');
    const created = seq++;
    const projection = projectNativeEvent(
      messages,
      frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 0, delta }, created)
    );
    expect(projection.changed?.[0]).toEqual(
      referenceDelta(previous, 'text', 0, delta, created, undefined)
    );
    messages = projection.messages;
  }
  expect(messages[1]?.message.content).toEqual([{ type: 'text', text: long }]);
});

test('a text delta at the replay frontier creates the first part the reference builds', () => {
  const messages = startAnswer([other], 1);
  const previous = messages[1];
  if (!previous) throw new Error('Missing projected answer');
  expect(previous.message.content).toEqual([]);
  const projection = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'first' }, 2)
  );
  expect(projection.changed).toHaveLength(1);
  expect(projection.changed?.[0]).toEqual(
    referenceDelta(previous, 'text', 0, 'first', 2, undefined)
  );
  expect(projection.changed?.[0]?.message.content).toEqual([{ type: 'text', text: 'first' }]);
  expect(projection.messages[1]).toBe(projection.changed?.[0]);
  expect(projection.messages[0]).toBe(other);
});

test('a reasoning delta at the replay frontier creates the part with the frame time and native', () => {
  const messages = startAnswer([other], 1);
  const previous = messages[1];
  if (!previous) throw new Error('Missing projected answer');
  expect(previous.message.content).toEqual([]);
  const native = { trace: 'trace_1', attempt: 2 };
  const projection = projectNativeEvent(
    messages,
    frame(
      'session.reasoning.delta',
      { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'thinking', native },
      2
    )
  );
  expect(projection.changed).toHaveLength(1);
  expect(projection.changed?.[0]).toEqual(
    referenceDelta(previous, 'reasoning', 0, 'thinking', 2, native)
  );
  expect(projection.changed?.[0]?.message.content?.[0]).toEqual({
    type: 'reasoning',
    text: 'thinking',
    time: { created: 2 },
    native,
  });
  expect(projection.messages[0]).toBe(other);
});

test('a delta past the replay frontier of empty content returns the incomplete marker', () => {
  const messages = startAnswer([other], 1);
  const previous = messages[1];
  if (!previous) throw new Error('Missing projected answer');
  expect(previous.message.content).toEqual([]);
  const projection = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 2, delta: 'x' }, 2)
  );
  expect(projection.changed).toHaveLength(1);
  expect(projection.changed?.[0]).toEqual(referenceDelta(previous, 'text', 2, 'x', 2, undefined));
  expect(projection.changed?.[0]?.incomplete).toBe(true);
  expect(projection.messages[1]?.message).toBe(previous.message);
  expect(projection.messages[0]).toBe(other);
});

test('a randomized frontier delta sequence keeps every entry equal to the reference', () => {
  const next = random(20261123);
  const chunks = ['a', 'bb', ' ', '\n', '…', ''];
  let messages = startAnswer([other], 10);
  const answer = messages[1];
  if (!answer) throw new Error('Missing projected answer');
  expect(answer.message.content).toEqual([]);
  let seq = 11;
  let createdParts = 0;
  let incompleteMarkers = 0;
  for (let step = 0; step < 120; step++) {
    const previous = messages[1];
    if (!previous) throw new Error('Missing projected answer');
    const kind = next() < 0.55 ? 'text' : 'reasoning';
    const ordinal = Math.floor(next() * 3);
    const delta = chunks[Math.floor(next() * chunks.length)] ?? 'x';
    const created = seq++;
    const native = kind === 'reasoning' && next() < 0.5 ? { trace: `trace_${created}` } : undefined;
    const projection = projectNativeEvent(
      messages,
      frame(
        `session.${kind}.delta`,
        { assistantMessageID: 'msg_answer', ordinal, delta, ...(native ? { native } : {}) },
        created
      )
    );
    const expected = referenceDelta(previous, kind, ordinal, delta, created, native);
    if (expected.incomplete) incompleteMarkers++;
    if ((expected.message.content?.length ?? 0) > (previous.message.content?.length ?? 0))
      createdParts++;
    expect(projection.changed).toHaveLength(1);
    expect(projection.changed?.[0]).toEqual(expected);
    expect(projection.messages[1]).toBe(projection.changed?.[0]);
    // The unrelated message never moves, whichever frame runs.
    expect(projection.messages[0]).toBe(other);
    messages = projection.messages;
  }
  expect(createdParts).toBeGreaterThan(0);
  expect(incompleteMarkers).toBeGreaterThan(0);
  expect(messages[1]?.message.content?.length).toBeGreaterThan(1);
});

test('a delta on a completed message returns the input array and reports no change', () => {
  let messages = startAnswer([other], 1);
  messages = applyNativeEvent(
    messages,
    frame('session.text.started', { assistantMessageID: 'msg_answer', ordinal: 0 }, 2)
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.step.ended',
      { assistantMessageID: 'msg_answer', finish: 'stop', cost: 1, tokens },
      3
    )
  );
  const projection = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'late' }, 4)
  );
  expect(projection.messages).toBe(messages);
  expect(projection.changed).toEqual([]);
});

test('a delta whose ordinal is past the stored content marks only that entry incomplete', () => {
  const messages = startAnswer([other], 1);
  const projection = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 3, delta: 'x' }, 2)
  );
  expect(projection.changed).toHaveLength(1);
  expect(projection.changed?.[0]).toEqual({ ...messages[1], incomplete: true });
  expect(projection.messages[1]?.message).toBe(messages[1]?.message);
  expect(projection.messages[0]).toBe(other);
});

test('the reported entries are the replaced ones for the single-message frame families', () => {
  let messages = startAnswer([other], 1);
  messages = applyNativeEvent(
    messages,
    frame('session.text.started', { assistantMessageID: 'msg_answer', ordinal: 0 }, 2)
  );

  const delta = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'hi' }, 3)
  );
  expect(delta.changed?.map(item => item.message.id)).toEqual(['msg_answer']);
  expect(delta.changed?.[0]?.message.content).toEqual([{ type: 'text', text: 'hi' }]);
  expect(delta.messages[1]).toBe(delta.changed?.[0]);

  const started = projectNativeEvent(
    messages,
    frame(
      'session.step.started',
      {
        assistantMessageID: 'msg_answer',
        started: 6,
        agent: 'build',
        model: { providerID: 'vendor', id: 'model' },
      },
      4
    )
  );
  expect(started.changed?.map(item => item.message.id)).toEqual(['msg_answer']);
  expect(started.changed?.[0]?.message.agent).toBe('build');

  const ended = projectNativeEvent(
    messages,
    frame(
      'session.step.ended',
      { assistantMessageID: 'msg_answer', finish: 'stop', cost: 2, tokens },
      5
    )
  );
  expect(ended.changed?.map(item => item.message.id)).toEqual(['msg_answer']);
  expect(ended.changed?.[0]?.message.time.completed).toBe(5);

  const streaming = projectNativeEvent(
    messages,
    frame(
      'session.tool.input.started',
      { assistantMessageID: 'msg_answer', id: 'call', name: 'shell' },
      6
    )
  );
  expect(streaming.changed?.map(item => item.message.id)).toEqual(['msg_answer']);
  const called = projectNativeEvent(
    streaming.messages,
    frame(
      'session.tool.called',
      { assistantMessageID: 'msg_answer', id: 'call', input: { command: 'true' }, executed: true },
      7
    )
  );
  expect(
    called.changed?.[0]?.message.content?.find(part => part.type === 'tool')?.state?.status
  ).toBe('running');
  const tool = projectNativeEvent(
    called.messages,
    frame(
      'session.tool.success',
      { assistantMessageID: 'msg_answer', id: 'call', executed: true, content: [] },
      8
    )
  );
  expect(tool.changed?.map(item => item.message.id)).toEqual(['msg_answer']);
  expect(
    tool.changed?.[0]?.message.content?.find(part => part.type === 'tool')?.state?.status
  ).toBe('completed');
});

test('a step start for an unseen id reports no entry list because it also clears a prior retry', () => {
  const withRetry = applyNativeEvent(
    startAnswer([other], 1),
    frame(
      'session.retry.scheduled',
      { assistantMessageID: 'msg_answer', attempt: 1, at: 5, error: { type: 'a', message: 'b' } },
      2
    )
  );
  expect(withRetry[1]?.message.retry).toBeDefined();
  const projection = projectNativeEvent(
    withRetry,
    frame(
      'session.step.started',
      {
        assistantMessageID: 'msg_fresh',
        started: 6,
        agent: 'build',
        model: { providerID: 'vendor', id: 'model' },
      },
      3
    )
  );
  expect(projection.changed).toBeUndefined();
  expect(projection.messages).toHaveLength(3);
  expect(projection.messages[1]?.message.retry).toBeUndefined();
  expect(projection.messages[2]?.message.id).toBe('msg_fresh');
});

test('frames that touch the transcript outside one entry report no entry list', () => {
  const messages: NativeSnapshotMessage[] = [other];
  const enqueued = projectNativeEvent(
    messages,
    frame(
      'session.inbox.enqueued',
      {
        inboxID: 'msg_inbox',
        item: { type: 'user', payload: { text: 'queued', type: 'user' } },
      },
      2
    )
  );
  expect(enqueued.changed).toBeUndefined();
  expect(enqueued.messages).toHaveLength(2);

  const cancelled = projectNativeEvent(
    enqueued.messages,
    frame('session.inbox.cancelled', { inboxID: 'msg_inbox' }, 3)
  );
  expect(cancelled.changed).toBeUndefined();
  expect(cancelled.messages.map(item => item.message.id)).toEqual(['msg_other']);

  const settled = projectNativeEvent(messages, frame('session.execution.succeeded', {}, 4));
  expect(settled.changed).toBeUndefined();
  expect(settled.messages.at(-1)?.message.type).toBe('idle');

  const renamed = projectNativeEvent(messages, frame('session.renamed', { title: 'Renamed' }, 5));
  expect(renamed.changed).toEqual([]);
  expect(renamed.messages).toBe(messages);

  const unknown = projectNativeEvent(messages, frame('session.unknown.frame', {}, 6));
  expect(unknown.changed).toEqual([]);
  expect(unknown.messages).toBe(messages);
});

test('a delta for an id the transcript does not hold returns the input array unchanged', () => {
  const messages: NativeSnapshotMessage[] = [other];
  const projection = projectNativeEvent(
    messages,
    frame('session.text.delta', { assistantMessageID: 'msg_absent', ordinal: 0, delta: 'x' }, 2)
  );
  expect(projection.messages).toBe(messages);
  expect(projection.changed).toEqual([]);
});
