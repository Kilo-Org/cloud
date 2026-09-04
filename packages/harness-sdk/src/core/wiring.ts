import { type Duration, Effect, type Option, PubSub, Ref, type Scope } from 'effect';
import type { SessionBusyError } from './ask.js';
import { ModelCatalog, type ModelCatalogService } from './catalog.js';
import { EntropySource, type EntropySourceService } from './entropy.js';
import {
  type Effort,
  ModelClient,
  type ModelClientService,
  type ModelError,
  type ModelUsage,
  zeroUsage,
} from './model.js';
import { PromptAssembler, type PromptAssemblerService } from './prompt.js';
import { type Continued, makePending, type Pending } from './queue.js';
import type { Session } from './session.js';
import { onStore, SessionStore, type SessionStoreService, type StoreError } from './storage.js';
import { locksFor, resolveTools, type Tool, type ToolMissingError } from './tool.js';

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
  /**
   * The tools this session offers, by name, in the order the model sees them.
   * Frozen for the same reason as the system prompt: they sit in front of every
   * message, so a change to the set or to the order moves the whole prefix.
   *
   * The names are resolved against the `ToolRegistry` when the session opens. A
   * name the registry does not hold fails there rather than at the first
   * question, and a session that names none never mentions tools at all.
   */
  readonly tools?: readonly string[];
  /**
   * How long the model waits for a tool before the call goes to the background.
   * 30 seconds by default. A tool may name its own, and its own wins.
   */
  readonly inlineFor?: Duration.DurationInput;
  /**
   * How many times one question may go back to the model before the loop stops
   * offering tools and asks for an answer in words. 24 by default.
   */
  readonly maxRounds?: number;
}

/**
 * Everything one session holds. Every plugin here is already resolved, and so
 * is every tool: the options name them and this holds the code behind them.
 */
interface Wiring extends Omit<SessionOptions, 'tools'> {
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
  /**
   * The tools this session offers, resolved once, in the order it named them.
   * Empty when it named none, which is the only test anything makes.
   */
  readonly tools: readonly Tool[];
  /**
   * One permit per tool that refused to overlap with itself, so two calls to it
   * queue rather than run together. A tool that allows overlap has no entry.
   */
  readonly locks: ReadonlyMap<string, Effect.Semaphore>;
  /**
   * The session's own scope. Work that has to outlive the question that started
   * it is forked here: a backgrounded tool, and the thing that drives what it
   * eventually says. Closing the session stops all of it.
   */
  readonly scope: Scope.Scope;
  /**
   * What the session has been given to say and has not said yet: the messages a
   * caller queued, and the results of tools the model stopped waiting for. See
   * `queue.ts` and `background.ts`.
   */
  readonly pending: Pending;
  /**
   * What the session did without being asked, for a caller that wants to show
   * it. Values are dropped rather than held when nobody is listening: these are
   * for display, and the transcript is the record.
   */
  readonly continued: PubSub.PubSub<Continued>;
}

/**
 * Why a round the session started on its own did not happen. `SessionBusyError`
 * is here because such a round waits for the question in flight, and gives up
 * rather than waiting forever on a session that never goes quiet.
 */
type ContinuedError = ModelError | StoreError | SessionBusyError;

/**
 * How many events of unwatched rounds the session keeps before it drops the
 * oldest. It is a display buffer, not a log, so it is small and it slides rather
 * than blocking the round that is publishing.
 *
 * The same number is the replay window, so a caller that queues a message and
 * only then reads `continued` still sees the answer. Without it the order of
 * two lines of a caller's own code would decide whether they see anything at
 * all, and the round can start before the subscription does.
 */
const continuedCapacity = 256;

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
  session: Session,
  /**
   * What the session's last request put in front of the model. A new session
   * has made none, and a resumed one takes what the store recorded: without it
   * a full conversation would go back out whole before anything compacts.
   */
  prompted = 0
): Effect.Effect<Wiring, ToolMissingError, SessionContext> =>
  Effect.gen(function* () {
    const tools = yield* resolveTools(options.tools ?? []);
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
      prompted: yield* Ref.make(prompted),
      busy: yield* Ref.make(false),
      tools,
      locks: yield* locksFor(tools),
      scope: yield* Effect.scope,
      pending: yield* makePending(yield* EntropySource),
      continued: yield* PubSub.sliding<Continued>({
        capacity: continuedCapacity,
        replay: continuedCapacity,
      }),
    };
    yield* Effect.addFinalizer(() =>
      Effect.ignore(onStore(wiring.store, plugin => plugin.flush()))
    );
    return wiring;
  });

export type { ContinuedError, SessionContext, SessionOptions, Wiring };
export { wiringFor };
