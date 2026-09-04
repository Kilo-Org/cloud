import { Effect, Ref, Stream } from 'effect';
import type { AskOptions } from './ask.js';
import { isFull } from './compact.js';
import {
  called,
  collect,
  commit,
  endRound,
  type Exchange,
  hidden,
  nextRound,
  said,
  thinking,
} from './exchange.js';
import type { ModelError, ModelEvent, ModelRequest } from './model.js';
import { sinceSummary } from './session.js';
import type { StoreError } from './storage.js';
import { definitionsOf } from './tool.js';
import { callsIn, resultsTurn, runCalls } from './tools.js';
import type { Wiring } from './wiring.js';

/**
 * One question, and every round it takes to answer it.
 *
 * Without tools a question is one request and one reply. With them the model
 * answers by asking for something, the tools answer, and the model is asked
 * again, until it stops asking. All of it is one exchange: one entry in the
 * store, one question in the transcript, one stream to the caller.
 *
 * The loop ends three ways. The model stops asking, which is the usual one. The
 * round ceiling is reached. Or the last request filled enough of the window that
 * the next one would be refused. The last two end the same way, with one more
 * request that offers no tools at all, so the model has to answer in words: an
 * exchange that stopped on a tool result would leave the transcript ending on
 * something the model never replied to, which no shape will take back.
 */

/**
 * The last resort, for a model the catalog does not name a limit for. It is a
 * floor, not an opinion: a caller that cares names a number.
 */
const defaultMaxTokens = 4096;

/**
 * How many times one question may go back to the model. It is a wall against a
 * model that calls the same tool forever, and every round past it is real money.
 */
const defaultMaxRounds = 24;

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

/** What every round of one question shares. */
interface Round {
  readonly wiring: Wiring;
  readonly exchange: Exchange;
  readonly options: AskOptions | undefined;
}

/**
 * The request for one round. `offer` is false on the round that has to end the
 * exchange: the model cannot ask for what it is not given.
 */
const requestFor = (round: Round, offer: boolean): Effect.Effect<ModelRequest> =>
  Effect.gen(function* () {
    const { wiring } = round;
    const { turns } = yield* Ref.get(wiring.state);
    /* Everything from the last summary onward. Before the first compaction
       that is every turn, and the call costs one scan of a list already held. */
    const asked = sinceSummary(turns);
    const maxTokens = yield* ceilingOf(wiring, round.options);
    const tools = offer ? definitionsOf(wiring.tools) : [];
    return {
      prompt: wiring.assembler.assemble({ system: wiring.system, turns: asked }),
      model: wiring.model,
      maxTokens,
      ...(wiring.effort === undefined ? {} : { effort: wiring.effort }),
      cacheKey: wiring.id,
      ...(tools.length === 0 ? {} : { tools }),
    };
  });

/** Everything one round hears, kept where it belongs. */
const heard = (round: Round, event: ModelEvent): Effect.Effect<void, StoreError> => {
  switch (event.kind) {
    case 'delta': {
      return said(round.exchange.spoken, event.text);
    }
    case 'reasoning': {
      return thinking(round.exchange.spoken, event);
    }
    case 'redacted': {
      return hidden(round.exchange.spoken, event.data);
    }
    case 'toolCall': {
      return called(round.exchange.spoken, event.call);
    }
    case 'done': {
      return Effect.asVoid(endRound(round.wiring, round.exchange, event));
    }
    /* Made here, from a tool, and never by the model. It is on the stream for
       the caller to show, and there is nothing to collect. */
    case 'toolResult': {
      return Effect.void;
    }
  }
};

/** Whether the model may be asked once more with its tools in hand. */
const mayContinue = (wiring: Wiring, rounds: number): Effect.Effect<boolean> =>
  Effect.map(isFull(wiring), full => !full && rounds < (wiring.maxRounds ?? defaultMaxRounds));

const roundsFrom = (round: Round, offer: boolean): Answer =>
  Stream.unwrap(
    Effect.map(Effect.zipRight(nextRound(round.exchange), requestFor(round, offer)), request =>
      round.wiring.client.stream(request).pipe(
        Stream.tap(event => heard(round, event)),
        Stream.concat(Stream.unwrap(afterRound(round, offer)))
      )
    )
  );

/**
 * Runs what the round asked for, and decides whether there is another.
 *
 * The results reach the caller as events of their own, so a harness can show
 * what its tools did without reading the transcript back.
 */
const answering = (round: Round, calls: ReturnType<typeof callsIn>): Effect.Effect<Answer> =>
  Effect.gen(function* () {
    const results = yield* runCalls(round.wiring, calls);
    yield* collect(round.wiring, round.exchange, yield* resultsTurn(round.wiring, results));
    const rounds = yield* Ref.get(round.exchange.rounds);
    const again = yield* mayContinue(round.wiring, rounds);
    const events = results.map((result): ModelEvent => ({ kind: 'toolResult', result }));
    return Stream.concat(Stream.fromIterable(events), roundsFrom(round, again));
  });

/**
 * What happens when a round's stream ends: either the exchange is written, or
 * the tools run and the model is asked again.
 */
const afterRound = (round: Round, offered: boolean): Effect.Effect<Answer, StoreError> =>
  Effect.gen(function* () {
    const stop = yield* Ref.get(round.exchange.stop);
    const written = yield* Ref.get(round.exchange.written);
    const last = written.at(-1);
    const calls = last === undefined ? [] : callsIn(last);
    if (!offered || stop !== 'tools' || calls.length === 0) {
      yield* commit(round.wiring, round.exchange);
      return Stream.empty;
    }
    return yield* answering(round, calls);
  });

export type { Answer, Round };
export { defaultMaxRounds, defaultMaxTokens, roundsFrom };
