import { Duration, Effect, Fiber, type Scope, Stream } from 'effect';
import type { SessionHandle } from '../src/core/handle.js';
import type { Continued } from '../src/core/queue.js';

/**
 * Watching the rounds a session runs on its own.
 *
 * A queued message and a late tool result are both answered without anybody
 * calling `ask`, and `session.continued` is where a caller sees that happen.
 * Reading it correctly is subtler than it looks — see `over` — which is why the
 * two runs that do it share one copy rather than keeping two in step.
 */

/** What one round the session ran on its own said, and which message it answers. */
interface Round {
  readonly answering: readonly string[];
  readonly text: string;
}

/** The event of one thing that happened, or nothing when the round failed. */
const eventIn = (one: Continued) => ('failed' in one ? undefined : one.event);

/**
 * True when a round is over rather than paused on a tool.
 *
 * `done` ends one call to the model, and a round that calls a tool makes
 * several. `tools` is the model waiting on a call the session is about to
 * answer, so it is the one stop reason that is not the end of anything. This is
 * how a caller knows a queued message has been answered in full.
 */
const over = (one: Continued): boolean => {
  const event = eventIn(one);
  return event?.kind === 'done' && event.stop !== 'tools';
};

/**
 * The rounds that were refused rather than answered. Empty is the healthy shape.
 *
 * One array for the module, because one process is one live run: each of these
 * files is its own `ttsx` invocation, so there is nothing to share it with.
 */
const refused: (readonly string[])[] = [];

/** A watch that has started: what it has seen, and the wait for the rest. */
interface Watching {
  /** The rounds seen so far. Complete once `done` has answered. */
  readonly rounds: readonly Round[];
  /** Waits for `count` rounds or for the deadline, and gives back the rounds. */
  readonly done: Effect.Effect<readonly Round[]>;
}

/**
 * Starts watching the rounds a session runs on its own, and hands back the
 * wait for them.
 *
 * **Nothing goes around the reading of `session.continued`.** Both
 * `Effect.timeout(...)` and `Stream.interruptAfter` read the same and are not:
 * either one puts a race around the subscription to the session's feed, the
 * scope of that subscription closes under the race, and the run then either
 * ends at once with nothing or waits forever on a queue no publisher can reach.
 * Measured against a live session on 2026-09-05, both ways, three times.
 *
 * So the reading is forked bare, and the deadline is on the waiting for it,
 * where a race costs nothing. What was collected before the deadline is
 * reported rather than thrown away with the failure: two rounds of three is a
 * far better failure to read than none.
 */
const watch = (
  session: SessionHandle,
  count: number,
  within: Duration.DurationInput = '180 seconds'
): Effect.Effect<Watching, never, Scope.Scope> => {
  const rounds: Round[] = [];
  let ended = 0;
  const held = { answering: [] as readonly string[], text: '' };
  const reading = Stream.runForEach(
    Stream.takeUntil(session.continued, one => over(one) && ++ended === count),
    (one: Continued) =>
      Effect.sync(() => {
        held.answering = one.answering;
        const event = eventIn(one);
        if (event?.kind === 'delta') {
          held.text += event.text;
        }
        /* A refused round is one message's bad news, not the end of the feed.
           The run says so rather than waiting for words that never come. */
        if ('failed' in one) {
          refused.push(one.answering);
        }
        if (over(one) || 'failed' in one) {
          rounds.push({ answering: held.answering, text: held.text });
          held.text = '';
        }
      })
  );
  return Effect.map(
    Effect.forkScoped(reading),
    (fiber): Watching => ({
      rounds,
      done: Effect.raceFirst(Fiber.await(fiber), Effect.sleep(within)).pipe(
        Effect.zipRight(Fiber.interrupt(fiber)),
        Effect.as(rounds as readonly Round[])
      ),
    })
  );
};

export type { Round, Watching };
export { eventIn, over, refused, watch };
