import { Context, Data, type Effect } from 'effect';
import type { Turn } from './turn.js';

/** A store failed to read or to write. */
class StoreError extends Data.TaggedError('harness/StoreError')<{
  readonly operation: 'append' | 'load' | 'flush';
  readonly cause: unknown;
}> {}

/**
 * Holds the turns of a session. The plugin has two jobs: take a turn and store
 * it, and read the turns back and parse them. `load` must validate what it
 * reads, because a store is an edge.
 *
 * The session notifies the plugin on every change and on close. When to write,
 * whether to batch, and how to recover is the plugin's decision.
 *
 * A store is optional. A session with no `SessionStore` in its context keeps
 * its turns in memory only.
 *
 * No plugin exists yet. The SQLite plugin comes later.
 */
interface SessionStoreService {
  /** The session calls this on every change. The plugin decides when to write. */
  readonly append: (turn: Turn) => Effect.Effect<void, StoreError>;
  readonly load: (sessionId: string) => Effect.Effect<readonly Turn[], StoreError>;
  /** Writes whatever the plugin still holds. The session calls this on close. */
  readonly flush: () => Effect.Effect<void, StoreError>;
}

class SessionStore extends Context.Tag('harness/SessionStore')<
  SessionStore,
  SessionStoreService
>() {}

export type { SessionStoreService };
export { SessionStore, StoreError };
