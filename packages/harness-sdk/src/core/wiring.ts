import { type Chunk, Effect, Ref, type Scope, type Stream } from 'effect';
import { type AskOptions, askWith, onStore, type SessionBusyError, type Wiring } from './ask.js';
import { ModelCatalog } from './catalog.js';
import { EntropySource } from './entropy.js';
import {
  type Effort,
  ModelClient,
  type ModelError,
  type ModelEvent,
  type ModelUsage,
  zeroUsage,
} from './model.js';
import { PromptAssembler } from './prompt.js';
import type { Session } from './session.js';
import { SessionStore, type StoreError } from './storage.js';
import type { PartDraft, Turn } from './turn.js';

/**
 * What a session is opened with. Every value is frozen for the life of the
 * session, and for the same reason: the system prompt is the front of the
 * cached prefix, a cache belongs to one model, and effort is part of the key.
 * Changing any of them mid-session throws the cache away.
 *
 * A store records these, so a session that is continued later is reopened with
 * the same ones rather than with whatever the caller passes the second time.
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
    input: string | readonly PartDraft[],
    options?: AskOptions
  ) => Stream.Stream<ModelEvent, ModelError | StoreError | SessionBusyError>;
  readonly history: Effect.Effect<Chunk.Chunk<Turn>>;
  /** The counts of every call so far. Pass to `hitRatio` for the cache share. */
  readonly usage: Effect.Effect<ModelUsage>;
}

/** Everything a session needs from its context, whether it is new or resumed. */
type SessionContext = PromptAssembler | ModelClient | ModelCatalog | EntropySource | Scope.Scope;

/**
 * Bridges to every plugin and resolves each one once, so the handle carries no
 * requirement of its own. What each plugin then does is the plugin's decision.
 *
 * The session is scoped. Closing the scope tells the store to write whatever it
 * still holds.
 */
const wiringFor = (
  options: SessionOptions,
  session: Session
): Effect.Effect<Wiring, never, SessionContext> =>
  Effect.gen(function* () {
    const wiring: Wiring = {
      ...options,
      id: session.id,
      entropy: yield* EntropySource,
      assembler: yield* PromptAssembler,
      client: yield* ModelClient,
      catalog: yield* ModelCatalog,
      store: yield* Effect.serviceOption(SessionStore),
      state: yield* Ref.make(session),
      totals: yield* Ref.make(zeroUsage),
      busy: yield* Ref.make(false),
    };
    yield* Effect.addFinalizer(() =>
      Effect.ignore(onStore(wiring.store, plugin => plugin.flush()))
    );
    return wiring;
  });

const handleOf = (wiring: Wiring): SessionHandle => ({
  id: wiring.id,
  ask: askWith(wiring),
  history: Effect.map(Ref.get(wiring.state), session => session.turns),
  usage: Ref.get(wiring.totals),
});

export type { SessionContext, SessionHandle, SessionOptions };
export { handleOf, wiringFor };
