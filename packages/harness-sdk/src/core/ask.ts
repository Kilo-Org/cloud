import { Data, Effect, Ref, Stream } from 'effect';
import { compactIfFull } from './compact.js';
import { exchangeFor, finish, hidden, remember, rollback, said, thinking } from './exchange.js';
import type { ModelError, ModelEvent } from './model.js';
import { sinceSummary } from './session.js';
import type { StoreError } from './storage.js';
import type { PartDraft } from './turn.js';
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

/** The stream one question answers with. */
type Answer = Stream.Stream<ModelEvent, ModelError | StoreError>;

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
              return said(exchange.spoken, event.text);
            }
            case 'reasoning': {
              return thinking(exchange.spoken, event);
            }
            case 'redacted': {
              return hidden(exchange.spoken, event.data);
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
