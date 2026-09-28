import { Deferred, Duration, Effect, Fiber, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { Continued } from './queue.js';
import { runWith } from './session-fixture.js';
import { type Tool, ToolRegistry } from './tool.js';

/**
 * Sending a call to the background while the model is still waiting for it.
 *
 * The deadline is a guess made before the call started. Somebody watching it
 * knows better: a person who has waited long enough, or an agent that decides
 * the answer is not worth the open request. Both say the same thing to the
 * session, and the session does not need to know which of them it was.
 *
 * Nothing is cancelled. The work carries on, and what it says arrives in a
 * round of its own — the same path the deadline takes, brought forward.
 */

const call = { id: 'tc_1', name: 'slow', arguments: '{}' };

/* Long enough that nothing here reaches it. Every backgrounding in this file is
   somebody deciding, never the clock. */
const options = {
  system: 'sys',
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: ['slow'],
  inlineFor: Duration.minutes(5),
};

const tool = (run: Tool['run']): Layer.Layer<ToolRegistry> =>
  Layer.succeed(ToolRegistry, {
    tools: [
      {
        definition: {
          name: 'slow',
          description: 'slow',
          parameters: { type: 'object', properties: {} },
        },
        run,
      },
    ],
  });

const resultsIn = (events: readonly { readonly kind: string }[]) =>
  events.filter(event => event.kind === 'toolResult');

const said = (seen: readonly Continued[]): string =>
  seen
    .map(one => {
      if ('failed' in one) {
        return '';
      }
      return one.event.kind === 'delta' ? one.event.text : '';
    })
    .join('');

it('moves the model on when the caller sends a running call away', async () => {
  const started = Effect.runSync(Deferred.make<boolean>());
  const answer = Effect.runSync(Deferred.make<string>());
  const { value } = await runWith({
    options,
    tools: tool(() => Effect.zipRight(Deferred.succeed(started, true), Deferred.await(answer))),
    replies: [
      { deltas: [], calls: [call], stop: 'tools' },
      { deltas: ['I will carry on'] },
      { deltas: ['it says nine'] },
    ],
    use: session =>
      Effect.gen(function* () {
        const watching = yield* Effect.fork(Stream.runCollect(Stream.take(session.continued, 2)));
        const asking = yield* Effect.fork(Stream.runCollect(session.ask('start the build')));
        /* Wait for the call to actually start, then send it away. Nothing about
           this is the clock: the deadline here is five minutes. */
        yield* Deferred.await(started);
        const waiting = yield* session.running;
        const sent = yield* session.background(call.id);
        const events = [...(yield* Fiber.join(asking))];
        /* The answer lands only after the model has been moved on, which is the
           whole shape of a call that outlives its request. */
        yield* Deferred.succeed(answer, 'nine');
        return { waiting, sent, events, seen: [...(yield* Fiber.join(watching))] };
      }),
  });

  expect(value.sent).toBe(true);
  expect(value.waiting).toMatchObject([{ id: 'tc_1', name: 'slow' }]);
  const [result] = resultsIn(value.events);
  expect(result).toMatchObject({ result: { callId: 'tc_1', failed: false } });
  expect(said(value.seen)).toBe('it says nine');
});

it('says no when there was nothing left to send away', async () => {
  const { value } = await runWith({
    options,
    tools: tool(() => Effect.succeed('exit 0')),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['the build passed'] }],
    use: session =>
      Effect.gen(function* () {
        /* Nothing is running yet. */
        const before = yield* session.background(call.id);
        yield* Stream.runDrain(session.ask('start the build'));
        /* And by now the call has answered, so it cannot be sent anywhere. */
        return { before, after: yield* session.background(call.id), left: yield* session.running };
      }),
  });

  expect(value).toEqual({ before: false, after: false, left: [] });
});

it('sends a call away once, however many times it is asked to', async () => {
  const started = Effect.runSync(Deferred.make<boolean>());
  const { value, calls } = await runWith({
    options,
    tools: tool(() => Effect.zipRight(Deferred.succeed(started, true), Effect.never)),
    replies: [{ deltas: [], calls: [call], stop: 'tools' }, { deltas: ['I will carry on'] }],
    use: session =>
      Effect.gen(function* () {
        const asking = yield* Effect.fork(Stream.runDrain(session.ask('start the build')));
        yield* Deferred.await(started);
        const first = yield* session.background(call.id);
        const again = yield* session.background(call.id);
        yield* Fiber.join(asking);
        return { first, again };
      }),
  });

  /* The second press is a person racing their own hand. It answers false and
     changes nothing: two rounds, not three. */
  expect(value).toEqual({ first: true, again: false });
  expect(calls).toHaveLength(2);
});
