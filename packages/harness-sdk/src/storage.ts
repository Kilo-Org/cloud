import { Context, Data, type Effect } from 'effect';
import type { Turn } from './turn.js';

/** A store failed to read or to write. */
class StoreError extends Data.TaggedError('harness/StoreError')<{
  readonly operation: 'append' | 'load';
  readonly cause: unknown;
}> {}

/**
 * Holds the turns of a session. The plugin has two jobs: take a turn and store
 * it, and read the turns back and parse them. `load` must validate what it
 * reads, because a store is an edge.
 *
 * No plugin exists yet. The SQLite plugin comes later.
 */
interface SessionStoreService {
  readonly append: (turn: Turn) => Effect.Effect<void, StoreError>;
  readonly load: (sessionId: string) => Effect.Effect<readonly Turn[], StoreError>;
}

class SessionStore extends Context.Tag('harness/SessionStore')<
  SessionStore,
  SessionStoreService
>() {}

export type { SessionStoreService };
export { SessionStore, StoreError };
