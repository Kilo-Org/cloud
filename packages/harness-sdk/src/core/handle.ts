import { Effect, Ref, type Stream } from 'effect';
import { type AskOptions, askWith, type SessionBusyError, whileFree } from './ask.js';
import { continuedOf, driveLate } from './background.js';
import { compactSession } from './compact.js';
import type { ModelError, ModelEvent, ModelUsage } from './model.js';
import type { StoreError } from './storage.js';
import type { PartDraft, Turn } from './turn.js';
import type { ContinuedError, Wiring } from './wiring.js';

/** A live session. It owns the turns, so a caller cannot lose one. */
interface SessionHandle {
  readonly id: string;
  /** Asks the model. The stream ends with `done`, which carries this call's counts. */
  readonly ask: (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ) => Stream.Stream<ModelEvent, ModelError | StoreError | SessionBusyError>;
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
   * The rounds the session ran without being asked, because a backgrounded tool
   * finished. It is empty for a session with no tools, and reading it a second
   * time starts a second subscription rather than continuing the first.
   *
   * The rounds happen whether or not anybody reads this. A caller that does not
   * watch loses the events, never the work, and the transcript holds all of it.
   */
  readonly continued: Stream.Stream<ModelEvent, ContinuedError>;
}

/**
 * The handle, and the thing that drives what the session does on its own.
 *
 * The driver is forked into the session's scope, so it lives as long as the
 * session and stops with it. A session with no tools starts none: nothing can
 * ever reach its queue.
 */
const handleOf = (wiring: Wiring): Effect.Effect<SessionHandle> =>
  Effect.as(
    wiring.tools.length === 0 ? Effect.void : Effect.forkIn(driveLate(wiring), wiring.scope),
    {
      id: wiring.id,
      ask: askWith(wiring),
      history: Effect.map(Ref.get(wiring.state), session => session.turns),
      usage: Ref.get(wiring.totals),
      compact: whileFree(wiring, compactSession(wiring)),
      continued: continuedOf(wiring),
    }
  );

export type { SessionHandle };
export { handleOf };
