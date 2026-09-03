import { type Chunk, Effect, Ref, type Scope, type Stream } from 'effect';
import { type AskOptions, askWith, onStore, type Wiring } from './ask.js';
import { ModelCatalog } from './catalog.js';
import {
  type Effort,
  ModelClient,
  type ModelError,
  type ModelEvent,
  type ModelUsage,
  zeroUsage,
} from './model.js';
import { PromptAssembler } from './prompt.js';
import { makeSession } from './session.js';
import { SessionStore, type StoreError } from './storage.js';
import type { Turn } from './turn.js';

/**
 * What a session is opened with. Both values are frozen for the life of the
 * session, and for the same reason: the system prompt is the front of the
 * cached prefix, and a cache belongs to one model. Changing either one
 * mid-session throws the cache away.
 */
interface SessionOptions {
  readonly system: string;
  readonly model: string;
  /**
   * The default ceiling on one answer. Without one the catalog's output limit
   * decides. One question may raise or lower it either way.
   */
  readonly maxTokens?: number;
  /** How hard the model should think. Frozen: a change invalidates the cache. */
  readonly effort?: Effort;
}

/** A live session. It owns the turns, so a caller cannot lose one. */
interface SessionHandle {
  readonly id: string;
  /** Asks the model. The stream ends with `done`, which carries this call's counts. */
  readonly ask: (
    text: string,
    options?: AskOptions
  ) => Stream.Stream<ModelEvent, ModelError | StoreError>;
  readonly history: Effect.Effect<Chunk.Chunk<Turn>>;
  /** The counts of every call so far. Pass to `hitRatio` for the cache share. */
  readonly usage: Effect.Effect<ModelUsage>;
}

/**
 * Opens a session. It bridges to every plugin and resolves each one once, so
 * the handle carries no requirement of its own. What each plugin then does is
 * the plugin's decision, not the session's.
 *
 * The session is scoped. Closing the scope tells the store to write whatever it
 * still holds.
 */
const openSession = (
  options: SessionOptions
): Effect.Effect<
  SessionHandle,
  never,
  PromptAssembler | ModelClient | ModelCatalog | Scope.Scope
> =>
  Effect.gen(function* () {
    const wiring: Wiring = {
      ...options,
      assembler: yield* PromptAssembler,
      client: yield* ModelClient,
      catalog: yield* ModelCatalog,
      store: yield* Effect.serviceOption(SessionStore),
      state: yield* Ref.make(yield* makeSession()),
      totals: yield* Ref.make(zeroUsage),
      gate: yield* Effect.makeSemaphore(1),
    };
    const { id } = yield* Ref.get(wiring.state);

    yield* Effect.addFinalizer(() =>
      Effect.ignore(onStore(wiring.store, plugin => plugin.flush()))
    );

    return {
      id,
      ask: askWith(wiring, id),
      history: Effect.map(Ref.get(wiring.state), session => session.turns),
      usage: Ref.get(wiring.totals),
    };
  });

export type { SessionHandle, SessionOptions };
export { openSession };
