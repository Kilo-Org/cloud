import { Data, Effect, Ref, Stream } from 'effect';
import { compactIfFull, promptedOf } from './compact.js';
import type { ModelError, ModelEvent, ModelUsage } from './model.js';
import { appendTurn, sinceSummary, type Session } from './session.js';
import { onStore, type StoreError } from './storage.js';
import { makeTurn, partsOf, type PartDraft, type Turn } from './turn.js';
import { add } from './usage.js';
import type { Wiring } from './wiring.js';

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

/** Adds a turn to the session in memory. The store hears at the end of the exchange. */
const remember = (wiring: Wiring, turn: Turn): Effect.Effect<void> =>
  Ref.update(wiring.state, session => appendTurn(session, turn));

/** The stream one question answers with. */
type Answer = Stream.Stream<ModelEvent, ModelError | StoreError>;

/** What is collected while the reply streams, to become the assistant's turn. */
interface Spoken {
  readonly text: Ref.Ref<string>;
  readonly reasoning: Ref.Ref<string>;
  /** Empty when the shape issues none, or when the model did not think. */
  readonly signature: Ref.Ref<string>;
}

/** One question and the answer it is waiting for. */
interface Exchange {
  readonly question: Turn;
  readonly spoken: Spoken;
  /** True once the answer arrived. See `rollback`. */
  readonly answered: Ref.Ref<boolean>;
  /** The session as it stood before the question, to go back to. */
  readonly before: Session;
}

/** What the model thought, if it thought at all, in the order it produced it. */
interface Thought {
  readonly body: string;
  readonly signature: string;
}

/**
 * The reasoning comes first, in the order the model produced it. It is kept
 * whenever there is a signature, even with no words: a provider that returns
 * the thinking as a summary defaults to no summary at all, so the block is
 * empty and still has to go back exactly as it came.
 *
 * The text part is always there: an answer of no words is still an answer, and
 * a turn with no text would shorten the prompt that follows.
 *
 * ponytail: one reasoning part per turn. A model interleaves thinking with tool
 * calls, so several blocks per turn arrive once this package has tools, and
 * each needs its own signature. Give the wire the block boundary then.
 */
const partsSaid = (said: string, thought: Thought): readonly PartDraft[] => {
  const answer: PartDraft = { kind: 'text', body: said };
  if (thought.body === '' && thought.signature === '') {
    return [answer];
  }
  return [
    {
      kind: 'reasoning',
      body: thought.body,
      ...(thought.signature === '' ? {} : { signature: thought.signature }),
    },
    answer,
  ];
};

/**
 * Writes the whole exchange and adds this call's counts to the session's. The
 * question is written here rather than when it was asked, so the store never
 * holds a question with no answer.
 */
const finish = (
  wiring: Wiring,
  exchange: Exchange,
  usage: ModelUsage
): Effect.Effect<void, StoreError> =>
  Effect.all({
    said: Ref.get(exchange.spoken.text),
    body: Ref.get(exchange.spoken.reasoning),
    signature: Ref.get(exchange.spoken.signature),
  }).pipe(
    Effect.flatMap(({ said, body, signature }) =>
      makeTurn(wiring.entropy, {
        sessionId: wiring.id,
        role: 'assistant',
        parts: partsSaid(said, { body, signature }),
      })
    ),
    Effect.tap(answer => remember(wiring, answer)),
    Effect.flatMap(answer =>
      onStore(wiring.store, plugin => plugin.append([exchange.question, answer]))
    ),
    Effect.zipRight(Ref.set(exchange.answered, true)),
    /* What this call put in front of the model, which is what decides whether
       the next one compacts first. It is the provider's own count, so no
       tokeniser is needed and no estimate can drift. */
    Effect.zipRight(Ref.set(wiring.prompted, promptedOf(usage))),
    Effect.zipRight(Ref.update(wiring.totals, held => add(held, usage)))
  );

/**
 * Collects one thinking event. The text and the signature arrive on separate
 * events, so each is kept where it belongs.
 */
const thinking = (
  spoken: Spoken,
  event: Extract<ModelEvent, { kind: 'reasoning' }>
): Effect.Effect<void> =>
  Ref.update(spoken.reasoning, held => held + event.text).pipe(
    Effect.zipRight(
      event.signature === undefined ? Effect.void : Ref.set(spoken.signature, event.signature)
    )
  );

/**
 * Takes the question back out when no answer came.
 *
 * A transcript that ends on an unanswered question sends it again with every
 * later request: the caller pays for it each time, and the model may answer it
 * late, on top of whatever was asked next. Nothing else may have touched the
 * session in between, because one session answers one question at a time.
 */
const rollback = (wiring: Wiring, exchange: Exchange): Effect.Effect<void> =>
  Effect.flatMap(Ref.get(exchange.answered), done =>
    done ? Effect.void : Ref.set(wiring.state, exchange.before)
  );

/** Everything one question needs before it goes out, made in one place. */
const exchangeFor = (
  wiring: Wiring,
  input: string | readonly PartDraft[]
): Effect.Effect<Exchange> =>
  Effect.all({
    before: Ref.get(wiring.state),
    question: makeTurn(wiring.entropy, {
      sessionId: wiring.id,
      role: 'user',
      parts: partsOf(input),
    }),
    spoken: Effect.all({
      text: Ref.make(''),
      reasoning: Ref.make(''),
      signature: Ref.make(''),
    }),
    answered: Ref.make(false),
  });

/**
 * Adds the question, then builds the stream of the answer. The assistant turn
 * is added only when the stream reaches `done`: a half written turn would
 * poison the prefix of every later request. If no answer arrives, `rollback`
 * takes the question back out again.
 */
const answerOf = (
  wiring: Wiring,
  input: string | readonly PartDraft[],
  options: AskOptions | undefined
): Effect.Effect<Answer, ModelError | StoreError> =>
  Effect.gen(function* () {
    /* Before anything else. A session that has filled the window would be
       refused, and compacting after the question was added would summarise the
       question along with the answers it has not had yet. */
    yield* compactIfFull(wiring);
    const exchange = yield* exchangeFor(wiring, input);
    yield* remember(wiring, exchange.question);
    const { turns } = yield* Ref.get(wiring.state);
    /* Everything from the last summary onward. Before the first compaction
       that is every turn, and the call costs one scan of a list already held. */
    const asked = sinceSummary(turns);
    const maxTokens = yield* ceilingOf(wiring, options);

    return wiring.client
      .stream({
        prompt: wiring.assembler.assemble({ system: wiring.system, turns: asked }),
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
              return Ref.update(exchange.spoken.text, held => held + event.text);
            }
            case 'reasoning': {
              return thinking(exchange.spoken, event);
            }
            case 'done': {
              return finish(wiring, exchange, event.usage);
            }
          }
        }),
        Stream.ensuring(rollback(wiring, exchange))
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
        (held): Effect.Effect<Answer, ModelError | StoreError | SessionBusyError> =>
          held
            ? Effect.fail(new SessionBusyError({ sessionId: wiring.id }))
            : answerOf(wiring, input, options).pipe(
                Effect.map(answer => Stream.ensuring(answer, Ref.set(wiring.busy, false))),
                Effect.onError(() => Ref.set(wiring.busy, false))
              )
      )
    );

export type { AskOptions };
export { askWith, SessionBusyError };
