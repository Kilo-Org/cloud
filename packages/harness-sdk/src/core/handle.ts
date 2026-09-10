import { Effect, Ref, type Stream } from 'effect';
import { type AskOptions, askWith, type SessionBusyError, whileFree } from './ask.js';
import { continuedOf, drivePending } from './background.js';
import { compactSession } from './compact.js';
import type { ModelError, ModelEvent, ModelUsage } from './model.js';
import { cancelQueued, type Continued, enqueueMessage, type Waiting } from './queue.js';
import type { StoreError } from './storage.js';
import { backgroundNow, type RunningCall, runningIn } from './waiting.js';
import type { PartDraft, Turn } from './turn.js';
import type { Wiring } from './wiring.js';

/** A live session. It owns the turns, so a caller cannot lose one. */
interface SessionHandle {
  readonly id: string;
  /** Asks the model. The stream ends with `done`, which carries this call's counts. */
  readonly ask: (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ) => Stream.Stream<ModelEvent, ModelError | StoreError | SessionBusyError>;
  /**
   * Hands the session a message to ask when it is free, and answers with the
   * identifier that cancels it.
   *
   * This is `ask` for a caller who cannot wait for the answer where they stand:
   * a person typing while the last answer is still arriving. It never refuses,
   * because it never competes for the session — it joins a line, and the line
   * is answered in the order it formed. The answer arrives on `continued`,
   * marked with the identifier this returns.
   */
  readonly queue: (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ) => Effect.Effect<string>;
  /**
   * Takes a queued message back out again. True when it was still waiting.
   *
   * False means it was already asked, or was never here. Neither is an error: a
   * caller racing their own cancel button against the session is ordinary, and
   * a message the provider has already seen cannot be taken back.
   */
  readonly cancel: (id: string) => Effect.Effect<boolean>;
  /** What is waiting to be said, in the order it will be. Empty when nothing is. */
  readonly queued: Effect.Effect<readonly Waiting[]>;
  /**
   * The calls the model is waiting on right now, oldest first. Show it, or read
   * it to decide what has waited long enough.
   */
  readonly running: Effect.Effect<readonly RunningCall[]>;
  /**
   * Stops the model waiting for one call, now, and answers whether it was still
   * waiting.
   *
   * The work is untouched: it keeps running, and what it says arrives in a
   * round of its own, exactly as it would have on the deadline. This is the
   * deadline brought forward by somebody who knows better than a fixed number —
   * a person watching a call take too long, or an agent deciding it has waited
   * enough. The session does not need to know which of them it was.
   *
   * False means the call has already been answered, has already gone to the
   * background, or was never here. None of those is an error.
   */
  readonly background: (callId: string) => Effect.Effect<boolean>;
  /** Every turn so far, oldest first. Appending a turn never changes this one. */
  readonly history: Effect.Effect<readonly Turn[]>;
  /** The counts of every call so far. Pass to `hitRatio` for the cache share. */
  readonly usage: Effect.Effect<ModelUsage>;
  /**
   * Replaces the conversation with a summary of itself, now, whatever the
   * window says. A session does this on its own when it fills the window; this
   * is for a caller that knows sooner, such as one changing subject.
   */
  readonly compact: Effect.Effect<void, ModelError | StoreError | SessionBusyError>;
  /**
   * The rounds the session ran without being asked where the caller stands: a
   * queued message, or a backgrounded tool that finally answered. Every event
   * carries the identifiers of the queued entries its round answers, so one
   * message's answer is told from another's. Reading it a second time starts a
   * second subscription rather than continuing the first.
   *
   * `done` ends one call to the model and not the round: a round that calls a
   * tool makes several, and every one of those but the last stops on `tools`.
   * A queued message is answered in full on the first `done` that stops on
   * anything else.
   *
   * A round the model or the store refused arrives here as `failed`, marked
   * with the same identifiers, rather than as a failure of the stream. One
   * message's bad news is not the end of the feed: the session keeps running
   * rounds for the rest of the line, and a caller whose subscription died on
   * the first refused round would hear about none of them.
   *
   * The rounds happen whether or not anybody reads this. A caller that does not
   * watch loses the events, never the work, and the transcript holds all of it.
   */
  readonly continued: Stream.Stream<Continued>;
}

/**
 * The handle, and the thing that drives what the session does on its own.
 *
 * The driver is forked into the session's scope, so it lives as long as the
 * session and stops with it. Every session starts one: any session can be
 * queued to, whether or not it has a tool.
 */
const handleOf = (wiring: Wiring): Effect.Effect<SessionHandle> =>
  Effect.as(Effect.forkIn(drivePending(wiring), wiring.scope), {
    id: wiring.id,
    ask: askWith(wiring),
    queue: (input: string | readonly PartDraft[], options?: AskOptions) =>
      enqueueMessage(wiring.pending, input, options),
    cancel: (id: string) => cancelQueued(wiring.pending, id),
    queued: Ref.get(wiring.pending.waiting),
    running: runningIn(wiring),
    background: (callId: string) => backgroundNow(wiring, callId),
    history: Effect.map(Ref.get(wiring.state), session => session.turns),
    usage: Ref.get(wiring.totals),
    compact: whileFree(wiring, compactSession(wiring)),
    continued: continuedOf(wiring),
  });

export type { SessionHandle };
export { handleOf };
