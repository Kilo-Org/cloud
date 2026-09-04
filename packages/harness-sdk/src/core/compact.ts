import { Effect, Option, Ref } from 'effect';
import type { ModelError } from './model.js';
import { appendTurn, sinceSummary } from './session.js';
import { onStore, type StoreError } from './storage.js';
import { add } from './usage.js';
import { makeTurn } from './turn.js';
import type { Wiring } from './wiring.js';

/**
 * Compaction: the conversation is replaced by a summary of itself.
 *
 * A session grows until the model refuses the request. The answer is the simple
 * one: summarise everything into a single message, start the next request with
 * that summary, and replay nothing else.
 *
 * The shape matters. Summarising the old turns and keeping the recent ones
 * verbatim looks better and is refused: a thinking block is signed against the
 * whole history that stood when it was produced, so a retained turn replayed
 * after a summary fails on its signature. Nothing carried over here is tied to
 * the old transcript.
 *
 * Compaction throws the model cache away, because every byte of the prefix
 * changes. That is the price of the session continuing at all.
 */

/**
 * What the summariser is told to keep.
 *
 * Everything before the summary is gone from the prompt, so the summary is all
 * the model will have of that work. A summariser left to its own judgement
 * writes a readable paragraph and drops the identifiers.
 */
const instruction =
  'Summarise the conversation above so it can continue without the earlier messages. ' +
  'Keep every fact, decision, name, number, identifier, file path, and open question ' +
  'that a later turn could need. Write compact notes, not prose. ' +
  'Add nothing that was not said, and do not answer anything.';

/** How the summary is introduced, so the model reads it as the record, not as a question. */
const heading = 'Summary of the conversation so far:';

/** The tokens one call put in front of the model, cached or not. */
const promptedOf = (usage: {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
}): number => usage.inputTokens + usage.cacheReadTokens;

/**
 * The share of the window a session may fill before it compacts. It leaves room
 * for the answer and for the question that triggers the check.
 */
const defaultCompactAt = 0.8;

/**
 * Whether the last call filled enough of the window to compact now.
 *
 * The number comes from the provider's own count of the last request, so no
 * tokeniser is needed and no estimate can drift. A catalog that does not name a
 * window never compacts: guessing one would either truncate a conversation that
 * fit, or fail to save one that did not.
 */
const windowOf = (wiring: Wiring): Effect.Effect<Option.Option<number>> =>
  wiring.catalog.facts(wiring.model).pipe(
    Effect.map(facts => Option.fromNullable(facts.contextWindow)),
    Effect.orElseSucceed(() => Option.none())
  );

const isFull = (wiring: Wiring): Effect.Effect<boolean> =>
  Effect.zipWith(Ref.get(wiring.prompted), windowOf(wiring), (prompted, window) =>
    Option.match(window, {
      onNone: () => false,
      onSome: size => prompted >= size * (wiring.compactAt ?? defaultCompactAt),
    })
  );

/**
 * Asks the model to summarise what the session holds now.
 *
 * The counts go into the session's total. A summary is a call like any other
 * and is billed like one, so a caller reading `usage` to know what a session
 * spent must see it; leaving it out under-reports every session that ever
 * compacted.
 */
const summaryOf = (wiring: Wiring): Effect.Effect<string, ModelError> =>
  Effect.flatMap(Ref.get(wiring.state), session => {
    const prompt = wiring.assembler.assemble({
      system: wiring.system,
      turns: sinceSummary(session.turns),
    });
    return wiring.client
      .send({
        prompt: {
          system: prompt.system,
          messages: [
            ...prompt.messages,
            { role: 'user', parts: [{ kind: 'text', text: instruction }], cache: false },
          ],
        },
        model: wiring.model,
        maxTokens: wiring.summaryTokens ?? defaultSummaryTokens,
        stream: false,
      })
      .pipe(
        Effect.tap(reply => Ref.update(wiring.totals, held => add(held, reply.usage))),
        Effect.map(reply => reply.content)
      );
  });

/**
 * The ceiling on a summary. It is a wall, not a target: a summariser that runs
 * past it produces a summary cut off mid-note, which is worse than a short one.
 */
const defaultSummaryTokens = 2048;

/**
 * Replaces the conversation with a summary of itself.
 *
 * The summary is a turn like any other, so it is written to the store and read
 * back by a session that is continued later. The turns before it stay where
 * they are: they are the record of what happened, and only the prompt starts
 * after them.
 */
const compactSession = (wiring: Wiring): Effect.Effect<void, ModelError | StoreError> =>
  Effect.gen(function* () {
    const said = yield* summaryOf(wiring);
    const turn = yield* makeTurn(wiring.entropy, {
      sessionId: wiring.id,
      role: 'user',
      parts: [{ kind: 'summary', body: `${heading}\n\n${said}` }],
    });
    yield* Ref.update(wiring.state, session => appendTurn(session, turn));
    yield* onStore(wiring.store, plugin => plugin.append([turn]));
    /* The next request starts from the summary, so what the last one cost says
       nothing about what the next one will. */
    yield* Ref.set(wiring.prompted, 0);
  });

/** Compacts when the last call filled the window, and does nothing otherwise. */
const compactIfFull = (wiring: Wiring): Effect.Effect<void, ModelError | StoreError> =>
  Effect.flatMap(isFull(wiring), full => (full ? compactSession(wiring) : Effect.void));

export { compactIfFull, compactSession, defaultCompactAt, promptedOf };
