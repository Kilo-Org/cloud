import { Context, Data, type Effect, type Option } from 'effect';
import type { Effort } from './model.js';
import type { Turn } from './turn.js';

/** A store failed to read or to write. */
class StoreError extends Data.TaggedError('harness/StoreError')<{
  readonly operation: 'create' | 'read' | 'append' | 'load' | 'flush';
  readonly cause: unknown;
}> {}

/**
 * What a session was opened with, as the store holds it.
 *
 * These are the values `SessionOptions` freezes, and they are stored because a
 * continued session must be opened with the same ones. Resuming under a system
 * prompt that differs by one byte drops the whole cached prefix, so the store
 * remembers rather than trusting the caller to pass them again.
 */
interface StoredSession {
  readonly id: string;
  readonly system: string;
  readonly model: string;
  readonly effort?: Effort;
  readonly maxTokens?: number;
}

/**
 * Holds the sessions and their turns. The plugin has two jobs: take what it is
 * given and store it, and read it back and parse it. Every read must validate
 * what it finds, because a store is an edge.
 *
 * The session notifies the plugin on every change and on close. When to write,
 * whether to batch, and how to recover is the plugin's decision.
 *
 * A store is optional. A session with no `SessionStore` in its context keeps
 * its turns in memory only, and cannot be continued or cloned.
 */
interface SessionStoreService {
  /** Records a new session. The session calls this once, at open. */
  readonly create: (session: StoredSession) => Effect.Effect<void, StoreError>;
  /** `None` when the store has never heard of the identifier. */
  readonly read: (sessionId: string) => Effect.Effect<Option.Option<StoredSession>, StoreError>;
  /**
   * Records one completed exchange: the question and the answer together. It
   * takes a list because the store must never hold a question with no answer.
   * Such a question goes back out with every later request, so the caller pays
   * for it again each time and the model may answer it late.
   */
  readonly append: (turns: readonly Turn[]) => Effect.Effect<void, StoreError>;
  /** The turns of one session, oldest first. */
  readonly load: (sessionId: string) => Effect.Effect<readonly Turn[], StoreError>;
  /** Writes whatever the plugin still holds. The session calls this on close. */
  readonly flush: () => Effect.Effect<void, StoreError>;
}

class SessionStore extends Context.Tag('harness/SessionStore')<
  SessionStore,
  SessionStoreService
>() {}

export type { SessionStoreService, StoredSession };
export { SessionStore, StoreError };
