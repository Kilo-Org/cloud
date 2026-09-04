import { Deferred, Duration, Effect, Fiber, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { Continued } from './queue.js';
import type { SessionHandle } from './handle.js';
import { recordingStore, runWith } from './session-fixture.js';
import { type Tool, ToolRegistry } from './tool.js';

/**
 * A message a caller sends while the session is busy, and taking one back.
 *
 * One session does one thing at a time, so a person typing while the last
 * answer is still arriving cannot be answered where they stand. They join a
 * line instead, the line is answered in the order it formed, and a message
 * still in the line can be taken out of it. That last part is what makes the
 * first part usable: a queue nobody can cancel is a queue that sends the thing
 * you changed your mind about.
 */

const options = { system: 'sys', model: 'claude-opus-5', maxTokens: 1024 };

const said = (seen: readonly Continued[]): string =>
  seen.map(one => (one.event.kind === 'delta' ? one.event.text : '')).join('');

/**
 * Everything each round of `continued` said, and what it was answering. An
 * identifier is answered by exactly one round, so grouping by it is grouping by
 * round.
 */
const rounds = (seen: readonly Continued[]) => {
  const held = new Map<string, { answering: readonly string[]; said: string }>();
  for (const one of seen) {
    const key = one.answering.join(',');
    held.set(key, { answering: one.answering, said: (held.get(key)?.said ?? '') + said([one]) });
  }
  return [...held.values()];
};

/** Watches `continued` until it has seen `count` rounds end. */
const watching = (session: SessionHandle, count: number) => {
  let ended = 0;
  return Effect.fork(
    Stream.runCollect(
      Stream.takeUntil(session.continued, one => {
        ended += one.event.kind === 'done' ? 1 : 0;
        return ended === count;
      })
    )
  );
};

it('asks a queued message and marks the answer with the identifier it gave back', async () => {
  const { value, calls } = await runWith({
    options,
    replies: [{ deltas: ['queued answer'] }],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 1);
        const id = yield* session.queue('what is up');
        return { id, seen: [...(yield* Fiber.join(seen))] };
      }),
  });

  expect(calls).toHaveLength(1);
  expect(rounds(value.seen)).toEqual([{ answering: [value.id], said: 'queued answer' }]);
});

it('answers the line in the order it formed, one turn per message', async () => {
  const store = recordingStore();
  const { value } = await runWith({
    options,
    store: store.layer,
    replies: [{ deltas: ['first'] }, { deltas: ['second'] }],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 2);
        const one = yield* session.queue('one');
        const two = yield* session.queue('two');
        return { one, two, seen: [...(yield* Fiber.join(seen))] };
      }),
  });

  expect(rounds(value.seen)).toEqual([
    { answering: [value.one], said: 'first' },
    { answering: [value.two], said: 'second' },
  ]);
  /* Two messages a caller wrote are two turns. Running them together would put
     words the caller wrote apart into one thing the conversation said. */
  expect(store.seen).toEqual([
    'user:one',
    'assistant:first',
    'user:two',
    'assistant:second',
    'flush',
  ]);
});

it('never asks a message that was cancelled while it waited', async () => {
  const store = recordingStore();
  const { value, calls } = await runWith({
    options,
    store: store.layer,
    replies: [{ deltas: ['only the second'] }],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 1);
        const dropped = yield* session.queue('never mind');
        const kept = yield* session.queue('this one');
        /* Both are still in the line: nothing can have been asked yet, because
           the driver holds the session before it takes anything out. */
        const took = yield* session.cancel(dropped);
        return { took, kept, seen: [...(yield* Fiber.join(seen))] };
      }),
  });

  expect(value.took).toBe(true);
  expect(calls).toHaveLength(1);
  expect(rounds(value.seen)).toEqual([{ answering: [value.kept], said: 'only the second' }]);
  expect(store.seen).toEqual(['user:this one', 'assistant:only the second', 'flush']);
});

it('says a message was not taken back when it had already been asked', async () => {
  const { value } = await runWith({
    options,
    replies: [{ deltas: ['done'] }],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 1);
        const id = yield* session.queue('go');
        yield* Fiber.join(seen);
        return { late: yield* session.cancel(id), missing: yield* session.cancel('que_nothing') };
      }),
  });

  /* Both false, and neither is a failure: a caller racing their own cancel
     button against the session is the ordinary case, and a message the provider
     has seen cannot be taken back. */
  expect(value).toEqual({ late: false, missing: false });
});

const gate = Effect.runSync(Deferred.make<boolean>());
/* Says when the tool is provably running, so the test queues while the session
   is busy rather than while a forked fiber is still scheduled. */
const started = Effect.runSync(Deferred.make<boolean>());

/** A tool that holds the session open until the test lets it go. */
const held: Tool = {
  definition: { name: 'held', description: 'held', parameters: { type: 'object', properties: {} } },
  run: () =>
    Effect.zipRight(Deferred.succeed(started, true), Effect.as(Deferred.await(gate), 'let go')),
};

it('shows what is waiting, in the order it will be asked', async () => {
  const { value } = await runWith({
    options: { ...options, tools: ['held'], inlineFor: Duration.minutes(1) },
    tools: Layer.succeed(ToolRegistry, { tools: [held] }),
    replies: [
      { deltas: [], calls: [{ id: 'tc_1', name: 'held', arguments: '{}' }], stop: 'tools' },
      { deltas: ['after the tool'] },
      { deltas: ['first queued'] },
      { deltas: ['second queued'] },
    ],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 2);
        /* The session is busy from here: the tool is waiting on the gate and the
           model is waiting on the tool. */
        const asking = yield* Effect.fork(Stream.runDrain(session.ask('use the tool')));
        yield* Deferred.await(started);
        const one = yield* session.queue('one');
        const two = yield* session.queue('two');
        const waiting = yield* session.queued;
        yield* Deferred.succeed(gate, true);
        yield* Fiber.join(asking);
        return { one, two, waiting, seen: [...(yield* Fiber.join(seen))] };
      }),
  });

  /* Both are visible while the session is busy, which is the whole point: a
     caller can show what will be sent, and take one of them back. */
  expect(value.waiting.map(one => ({ id: one.id, kind: one.kind }))).toEqual([
    { id: value.one, kind: 'message' },
    { id: value.two, kind: 'message' },
  ]);
  expect(rounds(value.seen)).toEqual([
    { answering: [value.one], said: 'first queued' },
    { answering: [value.two], said: 'second queued' },
  ]);
});

it('answers the tool results waiting at the front of the line together', async () => {
  const slow: Tool = {
    definition: {
      name: 'slow',
      description: 'slow',
      parameters: { type: 'object', properties: {} },
    },
    run: call => Effect.succeed(`${call.name} ${call.id} is done`),
  };

  const { value, calls } = await runWith({
    options: { ...options, tools: ['slow'], inlineFor: Duration.zero },
    tools: Layer.succeed(ToolRegistry, { tools: [slow] }),
    replies: [
      {
        deltas: [],
        calls: [
          { id: 'tc_1', name: 'slow', arguments: '{}' },
          { id: 'tc_2', name: 'slow', arguments: '{}' },
        ],
        stop: 'tools',
      },
      { deltas: ['I will wait'] },
      { deltas: ['both are done'] },
    ],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 1);
        yield* Stream.runDrain(session.ask('run both'));
        return [...(yield* Fiber.join(seen))];
      }),
  });

  /* One round, not two. The model asked for both calls in one turn and is
     waiting on both, so telling it about them one request at a time would cost
     a call and tell it less each time. */
  const [round] = rounds(value);
  expect(round?.said).toBe('both are done');
  expect(round?.answering).toHaveLength(2);
  expect(calls).toHaveLength(3);
  const last = calls[2]?.prompt.messages.at(-1)?.parts ?? [];
  const words = last.map(part => (part.kind === 'text' ? part.text : '')).join('');
  expect(words).toContain('tc_1');
  expect(words).toContain('tc_2');
});

it('takes the ceiling a queued message named, and not the session default', async () => {
  const { calls } = await runWith({
    options,
    replies: [{ deltas: ['ok'] }],
    use: session =>
      Effect.gen(function* () {
        const seen = yield* watching(session, 1);
        yield* session.queue('be brief', { maxTokens: 7 });
        yield* Fiber.join(seen);
      }),
  });

  expect(calls[0]?.maxTokens).toBe(7);
});
