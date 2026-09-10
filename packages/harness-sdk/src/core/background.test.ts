import { Deferred, Duration, Effect, Fiber, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ModelEvent } from './model.js';
import { recordingStore, runWith } from './session-fixture.js';
import { type Tool, ToolFailure, ToolRegistry } from './tool.js';

/**
 * What happens to a call the model stopped waiting for.
 *
 * Every tool can be backgrounded, and the harness decides when, not the tool.
 * The model is told the call is still running and carries on; the work keeps
 * going; and when it finally answers, the session starts a round of its own to
 * say so. Nothing about that is optional or opt-in — a person answering a
 * question, a build finishing, a deploy landing: all of them outlive a request,
 * and a harness that could only wait would be useless for every one of them.
 */

const tool = (name: string, run: Tool['run'], inlineFor?: Duration.DurationInput): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  ...(inlineFor === undefined ? {} : { inlineFor }),
  run,
});

const registry = (...tools: readonly Tool[]) => Layer.succeed(ToolRegistry, { tools });

const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['slow'],
  /* Nothing waits: every call to this session's tool is backgrounded at once. */
  inlineFor: Duration.zero,
};

const call = { id: 'tc_1', name: 'slow', arguments: '{}' };

const resultsIn = (events: readonly ModelEvent[]) =>
  events.filter(event => event.kind === 'toolResult').map(event => event.result);

/** The text of every request, so a test can see what the model was told. */
const askedWith = (parts: readonly { readonly kind: string }[]): readonly string[] =>
  parts.filter(part => part.kind === 'text').map(part => String(Reflect.get(part, 'text')));

it('tells the model a call is still running rather than holding the request open', async () => {
  const { value, calls } = await runWith({
    options,
    tools: registry(
      /* Never answers while the question is in flight. A harness that waited on
         this would sit on an open request until the provider gave up. */
      tool('slow', () => Effect.never)
    ),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['I will wait'] }],
    use: session =>
      Effect.map(Stream.runCollect(session.ask('start the build')), chunk => [...chunk]),
  });

  const [result] = resultsIn(value);
  expect(result).toMatchObject({ callId: 'tc_1', failed: false });
  expect(result?.body).toContain('still running');
  /* The exchange finished. The model answered on top of a call it never got. */
  expect(calls).toHaveLength(2);
});

it('starts a round of its own when the call finally answers', async () => {
  const store = recordingStore();
  const seen = await runWith({
    options,
    store: store.layer,
    replies: [
      { deltas: [], calls: [call], stop: 'tools' },
      { deltas: ['I will wait'] },
      { deltas: ['the build passed'] },
    ],
    tools: registry(tool('slow', () => Effect.succeed('exit 0'))),
    use: session =>
      Effect.gen(function* () {
        /* Watch before asking, so the round the session starts on its own has
           somewhere to go the moment it happens. */
        const watching = yield* Effect.fork(Stream.runCollect(Stream.take(session.continued, 2)));
        yield* Stream.runDrain(session.ask('start the build'));
        return [...(yield* Fiber.join(watching))];
      }),
  });

  /* Nobody asked a question. The result landing is what started the round. */
  const deltas = seen.value.flatMap(one =>
    'failed' in one || one.event.kind !== 'delta' ? [] : [one.event.text]
  );
  expect(deltas).toEqual(['the build passed']);
  /* And the request carried the answer as something the conversation said,
     never as a second result for a call that was already answered. */
  const said = askedWith(seen.calls[2]?.prompt.messages.at(-1)?.parts ?? []);
  expect(said.join('')).toContain('exit 0');
  expect(said.join('')).toContain('has finished');
});

it('writes the round it started on its own, like any other exchange', async () => {
  const store = recordingStore();
  await runWith({
    options,
    store: store.layer,
    replies: [
      { deltas: [], calls: [call], stop: 'tools' },
      { deltas: ['I will wait'] },
      { deltas: ['the build passed'] },
    ],
    tools: registry(tool('slow', () => Effect.succeed('exit 0'))),
    use: session =>
      Effect.gen(function* () {
        const watching = yield* Effect.fork(Stream.runDrain(Stream.take(session.continued, 2)));
        yield* Stream.runDrain(session.ask('start the build'));
        yield* watching.await;
      }),
  });

  /* Two exchanges: the one that was asked for, and the one the session ran on
     its own. The second is in the store like anything else. */
  expect(store.seen).toEqual([
    'user:start the build',
    'assistant:',
    'user:',
    'assistant:I will wait',
    expect.stringContaining('user:The slow call you made earlier'),
    'assistant:the build passed',
    'flush',
  ]);
});

it('tells the model a backgrounded call failed, in the round it starts', async () => {
  const { calls } = await runWith({
    options,
    replies: [
      { deltas: [], calls: [call], stop: 'tools' },
      { deltas: ['I will wait'] },
      { deltas: ['it did not work'] },
    ],
    tools: registry(tool('slow', () => Effect.fail(new ToolFailure({ cause: 'exit 1' })))),
    use: session =>
      Effect.gen(function* () {
        const watching = yield* Effect.fork(Stream.runDrain(Stream.take(session.continued, 2)));
        yield* Stream.runDrain(session.ask('start the build'));
        yield* watching.await;
      }),
  });

  const said = askedWith(calls[2]?.prompt.messages.at(-1)?.parts ?? []).join('');
  expect(said).toContain('has failed');
  expect(said).toContain('exit 1');
});

it('waits for the question in flight rather than asking over it', async () => {
  const gate = Effect.runSync(Deferred.make<boolean>());
  const { calls } = await runWith({
    options,
    replies: [
      { deltas: [], calls: [call], stop: 'tools' },
      { deltas: ['I will wait'] },
      { deltas: ['and now the build'] },
    ],
    /* Answers immediately, so the result lands while the second round of the
       first question is still streaming. */
    tools: registry(tool('slow', () => Effect.as(Deferred.await(gate), 'exit 0'))),
    use: session =>
      Effect.gen(function* () {
        const watching = yield* Effect.fork(Stream.runDrain(Stream.take(session.continued, 2)));
        yield* Deferred.succeed(gate, true);
        yield* Stream.runDrain(session.ask('start the build'));
        yield* watching.await;
      }),
  });

  /* Three calls and not four: the round the session started waited for the
     question, rather than running beside it and missing the cache. */
  expect(calls).toHaveLength(3);
  expect(askedWith(calls[2]?.prompt.messages.at(-1)?.parts ?? []).join('')).toContain('exit 0');
});

it('continues nothing on its own when nothing is waiting', async () => {
  const { calls } = await runWith({
    replies: [{ deltas: ['hello'] }],
    use: session =>
      Effect.zipRight(
        Stream.runDrain(session.ask('hi')),
        /* Nothing joined the line, so this ends on the timeout rather than on
           an event, and the session is none the worse for it. */
        Effect.ignore(Effect.timeout(Stream.runDrain(session.continued), Duration.millis(30)))
      ),
  });

  expect(calls).toHaveLength(1);
});
