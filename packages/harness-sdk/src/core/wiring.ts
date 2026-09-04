import { Chunk, Effect, type Option, Ref, type Scope, type Stream } from 'effect';
import { type AskOptions, askWith, type SessionBusyError } from './ask.js';
import { ModelCatalog, type ModelCatalogService } from './catalog.js';
import { compactSession } from './compact.js';
import { EntropySource, type EntropySourceService } from './entropy.js';
import {
  type Effort,
  ModelClient,
  type ModelClientService,
  type ModelError,
  type ModelEvent,
  type ModelUsage,
  zeroUsage,
} from './model.js';
import { PromptAssembler, type PromptAssemblerService } from './prompt.js';
import type { Session } from './session.js';
import { onStore, SessionStore, type SessionStoreService, type StoreError } from './storage.js';
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
  /**
   * The share of the model's context window a session may fill before it
   * compacts itself. `0.8` by default. A catalog that names no window for the
   * model never compacts, whatever this says.
   *
   * A share above 1 never compacts, and the session ends when the provider
   * refuses the request. A share at or below 0 compacts before every question,
   * which costs a summary call each time. Neither is checked: both are what
   * the number asks for, and the range is 0 to 1.
   */
  readonly compactAt?: number;
  /** The ceiling on one summary. 2048 by default. */
  readonly summaryTokens?: number;
}

/** Everything one session holds. Every plugin here is already resolved. */
interface Wiring extends SessionOptions {
  readonly id: string;
  readonly catalog: ModelCatalogService;
  readonly entropy: EntropySourceService;
  readonly assembler: PromptAssemblerService;
  readonly client: ModelClientService;
  readonly store: Option.Option<SessionStoreService>;
  readonly state: Ref.Ref<Session>;
  readonly totals: Ref.Ref<ModelUsage>;
  /** What the last request put in front of the model. Drives compaction. */
  readonly prompted: Ref.Ref<number>;
  /** True while a question is streaming. See `SessionBusyError`. */
  readonly busy: Ref.Ref<boolean>;
}

/** A live session. It owns the turns, so a caller cannot lose one. */
interface SessionHandle {
  readonly id: string;
  /** Asks the model. The stream ends with `done`, which carries this call's counts. */
  readonly ask: (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ) => Stream.Stream<ModelEvent, ModelError | StoreError | SessionBusyError>;
  /** Every turn so far, oldest first. A copy: appending to it changes nothing. */
  readonly history: Effect.Effect<readonly Turn[]>;
  /** The counts of every call so far. Pass to `hitRatio` for the cache share. */
  readonly usage: Effect.Effect<ModelUsage>;
  /**
   * Replaces the conversation with a summary of itself, now, whatever the
   * window says. A session does this on its own when it fills the window; this
   * is for a caller that knows sooner, such as one changing subject.
   */
  readonly compact: Effect.Effect<void, ModelError | StoreError>;
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
      prompted: yield* Ref.make(0),
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
  history: Effect.map(Ref.get(wiring.state), session => Chunk.toReadonlyArray(session.turns)),
  usage: Ref.get(wiring.totals),
  compact: compactSession(wiring),
});

export type { SessionContext, SessionHandle, SessionOptions, Wiring };
export { handleOf, wiringFor };
