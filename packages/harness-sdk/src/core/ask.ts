import { Effect, Option, Ref, Stream } from 'effect';
import type { ModelCatalogService } from './catalog.js';
import type { Effort, ModelClientService, ModelError, ModelEvent, ModelUsage } from './model.js';
import type { PromptAssemblerService } from './prompt.js';
import { appendTurn, type Session } from './session.js';
import type { SessionStoreService, StoreError } from './storage.js';
import { makeTurn, type Turn } from './turn.js';
import { add } from './usage.js';

/**
 * What one question may change. Only `maxTokens` may: it never reaches the
 * rendered prefix, so it costs no cache. The model, the system prompt, and the
 * effort are frozen for the life of the session.
 */
interface AskOptions {
  readonly maxTokens?: number;
}

/** Everything one session holds. Every plugin here is already resolved. */
interface Wiring {
  readonly system: string;
  readonly model: string;
  /** What the caller named at open. Without one the catalog decides. */
  readonly maxTokens?: number;
  readonly effort?: Effort;
  readonly catalog: ModelCatalogService;
  readonly assembler: PromptAssemblerService;
  readonly client: ModelClientService;
  readonly store: Option.Option<SessionStoreService>;
  readonly state: Ref.Ref<Session>;
  readonly totals: Ref.Ref<ModelUsage>;
  readonly gate: Effect.Semaphore;
}

const onStore = (
  store: Option.Option<SessionStoreService>,
  use: (plugin: SessionStoreService) => Effect.Effect<void, StoreError>
): Effect.Effect<void, StoreError> =>
  Option.match(store, { onNone: () => Effect.void, onSome: use });

/**
 * The last resort, for a model the catalog does not name a limit for. It is a
 * floor, not an opinion: a caller that cares names a number.
 */
const defaultMaxTokens = 4096;

/**
 * One question beats the session, and the session beats the catalog. The
 * catalog is only asked when nobody named a number, so the usual path costs
 * no lookup. A catalog that cannot answer is not an error here — the package
 * falls back rather than refusing to ask the question.
 */
const ceilingOf = (wiring: Wiring, options: AskOptions | undefined): Effect.Effect<number> => {
  const named = options?.maxTokens ?? wiring.maxTokens;
  return named === undefined
    ? wiring.catalog.facts(wiring.model).pipe(
        Effect.map(facts => facts.maxOutputTokens ?? defaultMaxTokens),
        Effect.orElseSucceed(() => defaultMaxTokens)
      )
    : Effect.succeed(named);
};

/** Adds a turn to the session and tells the store. The store decides when to write. */
const record = (wiring: Wiring, turn: Turn): Effect.Effect<void, StoreError> =>
  Ref.update(wiring.state, session => appendTurn(session, turn)).pipe(
    Effect.zipRight(onStore(wiring.store, plugin => plugin.append(turn)))
  );

/**
 * Asks the model and streams the reply. The assistant turn is added only when
 * the stream reaches `done`: a half written turn would poison the prefix of
 * every later request.
 *
 * One session answers one question at a time. Two questions at once would both
 * build on the same prefix, and the second would miss the cache.
 */
const askWith =
  (wiring: Wiring, id: string) =>
  (text: string, options?: AskOptions): Stream.Stream<ModelEvent, ModelError | StoreError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(wiring.gate.take(1), () => wiring.gate.release(1));
        yield* Effect.flatMap(makeTurn(id, 'user', text), turn => record(wiring, turn));
        const { turns } = yield* Ref.get(wiring.state);
        const spoken = yield* Ref.make('');
        const maxTokens = yield* ceilingOf(wiring, options);

        return wiring.client
          .stream({
            prompt: wiring.assembler.assemble({ system: wiring.system, turns }),
            model: wiring.model,
            maxTokens,
            ...(wiring.effort === undefined ? {} : { effort: wiring.effort }),
            stream: true,
            cacheKey: id,
          })
          .pipe(
            Stream.tap(event =>
              event.kind === 'delta'
                ? Ref.update(spoken, held => held + event.text)
                : Ref.get(spoken).pipe(
                    Effect.flatMap(said => makeTurn(id, 'assistant', said)),
                    Effect.flatMap(turn => record(wiring, turn)),
                    Effect.zipRight(Ref.update(wiring.totals, held => add(held, event.usage)))
                  )
            )
          );
      })
    );

export type { AskOptions, Wiring };
export { askWith, onStore };
