import { Effect, Ref, type Stream } from 'effect';
import { type AskOptions, askWith, type SessionBusyError, whileFree } from './ask.js';
import { compactSession } from './compact.js';
import type { ModelError, ModelEvent, ModelUsage } from './model.js';
import type { StoreError } from './storage.js';
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
}

const handleOf = (wiring: Wiring): SessionHandle => ({
  id: wiring.id,
  ask: askWith(wiring),
  history: Effect.map(Ref.get(wiring.state), session => session.turns),
  usage: Ref.get(wiring.totals),
  compact: whileFree(wiring, compactSession(wiring)),
});

export type { SessionHandle };
export { handleOf };
