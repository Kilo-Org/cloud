import { Data, Effect, Option, Ref, Stream } from 'effect';
import type { ModelCatalogService } from './catalog.js';
import type { EntropySourceService } from './entropy.js';
import type { Effort, ModelClientService, ModelError, ModelEvent, ModelUsage } from './model.js';
import type { PromptAssemblerService } from './prompt.js';
import { appendTurn, type Session } from './session.js';
import type { SessionStoreService, StoreError } from './storage.js';
import { makeTurn, partsOf, type PartDraft, type Turn } from './turn.js';
import { add } from './usage.js';

/**
 * A second question was asked while the first was still streaming. One session
 * answers one question at a time, so the second is refused rather than queued.
 * Wait for the first stream to end, then ask again.
 */
class SessionBusyError extends Data.TaggedError('harness/SessionBusyError')<{
  readonly sessionId: string;
}> {}

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
  readonly id: string;
  readonly system: string;
  readonly model: string;
  /** What the caller named at open. Without one the catalog decides. */
  readonly maxTokens?: number;
  readonly effort?: Effort;
  readonly catalog: ModelCatalogService;
  readonly entropy: EntropySourceService;
  readonly assembler: PromptAssemblerService;
  readonly client: ModelClientService;
  readonly store: Option.Option<SessionStoreService>;
  readonly state: Ref.Ref<Session>;
  readonly totals: Ref.Ref<ModelUsage>;
  /** True while a question is streaming. See `SessionBusyError`. */
  readonly busy: Ref.Ref<boolean>;
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

/** The stream one question answers with. */
type Answer = Stream.Stream<ModelEvent, ModelError | StoreError>;

/** What is collected while the reply streams, to become the assistant's turn. */
interface Spoken {
  readonly text: Ref.Ref<string>;
  readonly reasoning: Ref.Ref<string>;
}

/**
 * The reasoning comes first, in the order the model produced it, and only when
 * there was any. The text part is always there: an answer of no words is still
 * an answer, and a turn with no text would shorten the prompt that follows.
 */
const partsSaid = (said: string, thought: string): readonly PartDraft[] =>
  thought === ''
    ? [{ kind: 'text', body: said }]
    : [
        { kind: 'reasoning', body: thought },
        { kind: 'text', body: said },
      ];

/** Writes the assistant's turn and adds this call's counts to the session's. */
const finish = (
  wiring: Wiring,
  spoken: Spoken,
  usage: ModelUsage
): Effect.Effect<void, StoreError> =>
  Effect.all({ said: Ref.get(spoken.text), thought: Ref.get(spoken.reasoning) }).pipe(
    Effect.flatMap(({ said, thought }) =>
      makeTurn(wiring.entropy, {
        sessionId: wiring.id,
        role: 'assistant',
        parts: partsSaid(said, thought),
      })
    ),
    Effect.flatMap(turn => record(wiring, turn)),
    Effect.zipRight(Ref.update(wiring.totals, held => add(held, usage)))
  );

/**
 * Records the question, then builds the stream of the answer. The assistant
 * turn is added only when the stream reaches `done`: a half written turn would
 * poison the prefix of every later request.
 */
const answerOf = (
  wiring: Wiring,
  input: string | readonly PartDraft[],
  options: AskOptions | undefined
): Effect.Effect<Answer, StoreError> =>
  Effect.gen(function* () {
    yield* Effect.flatMap(
      makeTurn(wiring.entropy, { sessionId: wiring.id, role: 'user', parts: partsOf(input) }),
      turn => record(wiring, turn)
    );
    const { turns } = yield* Ref.get(wiring.state);
    const spoken: Spoken = { text: yield* Ref.make(''), reasoning: yield* Ref.make('') };
    const maxTokens = yield* ceilingOf(wiring, options);

    return wiring.client
      .stream({
        prompt: wiring.assembler.assemble({ system: wiring.system, turns }),
        model: wiring.model,
        maxTokens,
        ...(wiring.effort === undefined ? {} : { effort: wiring.effort }),
        stream: true,
        cacheKey: wiring.id,
      })
      .pipe(
        Stream.tap(event => {
          switch (event.kind) {
            case 'delta': {
              return Ref.update(spoken.text, held => held + event.text);
            }
            case 'reasoning': {
              return Ref.update(spoken.reasoning, held => held + event.text);
            }
            case 'done': {
              return finish(wiring, spoken, event.usage);
            }
          }
        })
      );
  });

/**
 * Asks the model and streams the reply.
 *
 * One session answers one question at a time: two at once would both build on
 * the same prefix, and the second would miss the cache. A second question
 * asked while the first still streams fails with `SessionBusyError`. It is
 * refused rather than queued because a queued question cannot be released
 * under `Stream.merge` — the merged stream holds every child resource until
 * all children finish, so waiting would deadlock, and uninterruptibly.
 */
const askWith =
  (wiring: Wiring) =>
  (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ): Stream.Stream<ModelEvent, ModelError | StoreError | SessionBusyError> =>
    Stream.unwrap(
      Effect.flatMap(
        Ref.getAndSet(wiring.busy, true),
        (held): Effect.Effect<Answer, StoreError | SessionBusyError> =>
          held
            ? Effect.fail(new SessionBusyError({ sessionId: wiring.id }))
            : answerOf(wiring, input, options).pipe(
                Effect.map(answer => Stream.ensuring(answer, Ref.set(wiring.busy, false))),
                Effect.onError(() => Ref.set(wiring.busy, false))
              )
      )
    );

export type { AskOptions, Wiring };
export { askWith, onStore, SessionBusyError };
