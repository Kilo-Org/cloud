import { Data, Effect, Ref, Stream } from 'effect';
import { compactIfFull } from './compact.js';
import { exchangeFor, remember, rollback } from './exchange.js';
import { type Answer, roundsFrom } from './loop.js';
import type { ModelError, ModelEvent } from './model.js';
import type { StoreError } from './storage.js';
import type { PartDraft } from './turn.js';
import type { Wiring } from './wiring.js';

/**
 * Something else already holds the session: a question was asked, or a
 * compaction started, while an answer was still streaming. One session does
 * one thing at a time, so the second is refused rather than queued. Wait for
 * the stream to end, then try again.
 */
class SessionBusyError extends Data.TaggedError('harness/SessionBusyError')<{
  readonly sessionId: string;
}> {}

/**
 * What one question may change. Only `maxTokens` may: it never reaches the
 * rendered prefix, so it costs no cache. The model, the system prompt, the
 * effort, and the tools are frozen for the life of the session.
 */
interface AskOptions {
  readonly maxTokens?: number;
}

/**
 * Adds the question, then builds the stream of everything that answers it.
 *
 * A turn is added to the session as it is made and to the store only when the
 * whole exchange is done, because a half written exchange would poison the
 * prefix of every later request. If no answer arrives, `rollback` takes the
 * question back out again. What the rounds do is `loop.ts`.
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
    const rounds = roundsFrom({ wiring, exchange, options }, wiring.tools.length > 0);
    return Stream.ensuring(rounds, rollback(wiring, exchange));
  });

/**
 * Asks the model with the session already held.
 *
 * It is what `askWith` does once it has the lock, and what the driver in
 * `background.ts` uses under `whileFree`: that driver has to hold the session
 * before it takes anything out of the line, or a message could be taken out,
 * find the session busy, and be neither queued nor asked while a caller is
 * looking at it.
 */
const askHeld =
  (wiring: Wiring) =>
  (
    input: string | readonly PartDraft[],
    options?: AskOptions
  ): Stream.Stream<ModelEvent, ModelError | StoreError> =>
    Stream.unwrap(answerOf(wiring, input, options));

/**
 * Asks the model and streams the reply.
 *
 * One session does one thing at a time: two answers at once would both build
 * on the same prefix, and the second would miss the cache. A second question
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

/**
 * Runs the work only when nothing else holds the session.
 *
 * Compaction rewrites the whole conversation, and a question in flight holds
 * the session as it stood before it was asked, to put back if no answer comes.
 * Both at once lose the summary from memory while the store keeps it. So
 * compaction takes the same lock a question takes, and is refused the same way.
 */
const whileFree = <A, E>(
  wiring: Wiring,
  work: Effect.Effect<A, E>
): Effect.Effect<A, E | SessionBusyError> =>
  Effect.acquireUseRelease(
    Effect.flatMap(Ref.getAndSet(wiring.busy, true), held =>
      held ? Effect.fail(new SessionBusyError({ sessionId: wiring.id })) : Effect.void
    ),
    () => work,
    () => Ref.set(wiring.busy, false)
  );

export type { AskOptions };
export { askHeld, askWith, SessionBusyError, whileFree };
