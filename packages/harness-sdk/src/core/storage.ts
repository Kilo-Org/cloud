import { Context, Data, Effect, Option } from 'effect';
import type { Effort } from './model.js';
import type { Turn } from './turn.js';

/** A store failed to read or to write. */
class StoreError extends Data.TaggedError('harness/StoreError')<{
  readonly operation: 'create' | 'read' | 'append' | 'load' | 'flush';
  readonly cause: unknown;
}> {}

/**
 * Everything the store must give back for a session to be reopened as it stood.
 *
 * Most of it is what `SessionOptions` freezes, stored because a continued
 * session must be opened with the same values. Resuming under a system prompt
 * that differs by one byte drops the whole cached prefix, so the store
 * remembers rather than trusting the caller to pass them again.
 *
 * `prompted` is the exception: it changes with every answer. It is the
 * provider's own count of the last request, and it is what decides whether the
 * next question compacts first. Absent means no request has been recorded yet,
 * which is a new session, or one written before this package stored the count.
 */
interface StoredSession {
  readonly id: string;
  readonly system: string;
  readonly model: string;
  readonly effort?: Effort;
  readonly maxTokens?: number;
  readonly prompted?: number;
}

/**
 * One completed exchange, as the store takes it.
 *
 * The turns and the count go together because they describe the same request:
 * a store that wrote the turns and lost the count would hand back a session
 * that does not know how full it is, and a store that wrote the count without
 * the turns would hand back one that thinks it is fuller than it is.
 */
interface StoredExchange {
  /** The session this belongs to, named as every other method here names it. */
  readonly sessionId: string;
  /**
   * The turns to record. It is a list because the store must never hold a
   * question with no answer: such a question goes back out with every later
   * request, so the caller pays for it again each time and the model may answer
   * it late.
   */
  readonly turns: readonly Turn[];
  /**
   * What the request that produced them put in front of the model, from the
   * provider's own count. A compaction records zero: the next request starts
   * from the summary, so what the last one cost says nothing about it.
   */
  readonly prompted: number;
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
  /** Records one completed exchange, turns and count together, or neither. */
  readonly append: (exchange: StoredExchange) => Effect.Effect<void, StoreError>;
  /** The turns of one session, oldest first. */
  readonly load: (sessionId: string) => Effect.Effect<readonly Turn[], StoreError>;
  /** Writes whatever the plugin still holds. The session calls this on close. */
  readonly flush: () => Effect.Effect<void, StoreError>;
}

class SessionStore extends Context.Tag('harness/SessionStore')<
  SessionStore,
  SessionStoreService
>() {}

/** Runs the work when there is a store, and does nothing when there is not. */
const onStore = (
  store: Option.Option<SessionStoreService>,
  use: (plugin: SessionStoreService) => Effect.Effect<void, StoreError>
): Effect.Effect<void, StoreError> =>
  Option.match(store, { onNone: () => Effect.void, onSome: use });

export type { SessionStoreService, StoredExchange, StoredSession };
export { onStore, SessionStore, StoreError };
