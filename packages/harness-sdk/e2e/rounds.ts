import { Effect, Stream } from 'effect';
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

/** Collects the rounds the session runs on its own, until `count` have ended. */
const watch = (session: SessionHandle, count: number) => {
  const rounds: Round[] = [];
  let ended = 0;
  const held = { answering: [] as readonly string[], text: '' };
  return Stream.runForEach(
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
  ).pipe(Effect.as(rounds));
};

export type { Round };
export { eventIn, over, refused, watch };
