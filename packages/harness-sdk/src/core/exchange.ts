import { Effect, Ref } from 'effect';
import { promptedOf } from './compact.js';
import type { ModelEvent, ModelUsage, StopReason } from './model.js';
import { appendTurn, type Session } from './session.js';
import { onStore, type StoreError } from './storage.js';
import type { ToolCall } from './tool.js';
import { makeTurn, partsOf, type PartDraft, type Turn } from './turn.js';
import { add } from './usage.js';
import type { Wiring } from './wiring.js';

/**
 * One question and everything it produces before the model stops asking.
 *
 * A question and its answer are written together or not at all. Half of an
 * exchange is worse than none: a transcript that ends on an unanswered
 * question sends it again with every later request, the caller pays for it
 * each time, and the model may answer it late on top of whatever was asked
 * next. So the turn goes into the session as the question is asked, into the
 * store only when the answer arrives, and back out again when it does not.
 *
 * Tools make one question into several rounds — the model asks for a tool, the
 * tool answers, the model is asked again — and that rule holds across all of
 * them. Every shape refuses a call whose result is missing, so a store holding
 * half a round holds a session nobody can continue. The turns are collected as
 * they are made and written once, at the end, by `commit`.
 *
 * What drives the rounds is `loop.ts`.
 */

/** Adds a turn to the session in memory. The store hears at the end of the exchange. */
const remember = (wiring: Wiring, turn: Turn): Effect.Effect<void> =>
  Ref.update(wiring.state, session => appendTurn(session, turn));

/**
 * What is collected while one round streams, to become the assistant's turn.
 *
 * One record rather than a ref per field. Copying the other on every token
 * costs 0.054 us against 0.402 for the update alone, measured 2026-09-04 over
 * 200000 rounds, which is a third of a percent of the 18.1 us a token costs
 * through the whole session. `endRound` reads it once.
 */
interface Spoken {
  readonly text: string;
  /**
   * The thinking, in the order it arrived, encrypted blocks among the rest.
   *
   * It is a list and not a pair of fields because the provider refuses a turn
   * whose thinking blocks do not come back in the order it produced them. A
   * model that has part of its reasoning redacted returns thinking, then an
   * encrypted block, then more thinking; holding the words in one field and
   * the encrypted blocks in another loses which came first.
   */
  readonly thought: readonly PartDraft[];
  /**
   * The tools the model asked for, in the order it asked. A turn may hold
   * several, and each is answered before the next request goes out.
   */
  readonly calls: readonly PartDraft[];
}

const nothingSaid: Spoken = { text: '', thought: [], calls: [] };

interface Exchange {
  readonly question: Turn;
  /** What the round now streaming has said. Emptied at the start of each one. */
  readonly spoken: Ref.Ref<Spoken>;
  /**
   * Every turn this question has made: the answers, the calls, and the results.
   * They are written to the store together, once, when the loop ends.
   */
  readonly written: Ref.Ref<readonly Turn[]>;
  /** Why the model stopped the round that just ended. `tools` means ask again. */
  readonly stop: Ref.Ref<StopReason>;
  /** How many times the model has been asked. See `maxRounds`. */
  readonly rounds: Ref.Ref<number>;
  /** True once the store has it. See `rollback`. */
  readonly answered: Ref.Ref<boolean>;
  /** The session as it stood before the question, to go back to. */
  readonly before: Session;
}

/**
 * The thinking comes first, in the order the model produced it, then the words,
 * then the tools it asked for. Every shape wants that order and refuses another.
 * A reasoning block is kept even with no words: a provider that returns the
 * thinking as a summary defaults to no summary at all, so the block is empty and
 * still has to go back exactly as it came.
 *
 * The text part is always there when nothing else is: an answer of no words is
 * still an answer, and a turn with no parts would shorten the prompt that
 * follows. It is left out of a turn that asked for a tool and said nothing,
 * because a provider refuses an empty text block beside a call.
 */
const partsSaid = (spoken: Spoken): readonly PartDraft[] => {
  const said: readonly PartDraft[] =
    spoken.text.length === 0 && spoken.calls.length > 0
      ? []
      : [{ kind: 'text', body: spoken.text }];
  return [...spoken.thought, ...said, ...spoken.calls];
};

/** Keeps a turn this question made, in memory and on the list to be written. */
const collect = (wiring: Wiring, exchange: Exchange, turn: Turn): Effect.Effect<void> =>
  Effect.zipRight(
    remember(wiring, turn),
    Ref.update(exchange.written, held => [...held, turn])
  );

/**
 * Closes one round: what the model said becomes a turn, and what the round cost
 * goes into the session's total and into the count that decides compaction.
 *
 * The turn is not written to the store here. The model may be about to ask for
 * a tool, and a call stored without its result is a session that cannot be
 * continued, so the writing waits for `commit`.
 */
const endRound = (
  wiring: Wiring,
  exchange: Exchange,
  ended: { readonly usage: ModelUsage; readonly stop: StopReason }
): Effect.Effect<Turn> =>
  Ref.get(exchange.spoken).pipe(
    Effect.flatMap(spoken =>
      makeTurn(wiring.entropy, {
        sessionId: wiring.id,
        role: 'assistant',
        parts: partsSaid(spoken),
      })
    ),
    Effect.tap(answer => collect(wiring, exchange, answer)),
    Effect.tap(() => Ref.set(exchange.stop, ended.stop)),
    Effect.tap(() => Ref.update(exchange.rounds, held => held + 1)),
    /* What this call put in front of the model, which is what decides whether
       the next question compacts first. It is the provider's own count, so no
       tokeniser is needed and no estimate can drift. */
    Effect.tap(() => Ref.set(wiring.prompted, promptedOf(ended.usage))),
    Effect.tap(() => Ref.update(wiring.totals, held => add(held, ended.usage)))
  );

/**
 * Writes the question and everything it produced, as one unit.
 *
 * The question is written here rather than when it was asked, so the store
 * never holds a question with no answer, and never a call with no result.
 */
const commit = (wiring: Wiring, exchange: Exchange): Effect.Effect<void, StoreError> =>
  Effect.flatMap(
    Effect.all({ turns: Ref.get(exchange.written), prompted: Ref.get(wiring.prompted) }),
    ({ turns, prompted }) =>
      onStore(wiring.store, plugin =>
        plugin.append({ sessionId: wiring.id, turns: [exchange.question, ...turns], prompted })
      )
  ).pipe(Effect.zipRight(Ref.set(exchange.answered, true)));

/**
 * Collects one thinking event into the block it belongs to.
 *
 * The words and the signature arrive on separate events, so both land on the
 * block still open. A block stays open until something else arrives: an
 * encrypted block closes it, a signature closes it, and the next thinking event
 * opens a new one. A model produces two signed blocks in a row between tool
 * calls, and merging them would hand the provider one block under the other's
 * seal.
 */
const thinking = (
  spoken: Ref.Ref<Spoken>,
  event: Extract<ModelEvent, { kind: 'reasoning' }>
): Effect.Effect<void> =>
  Ref.update(spoken, held => {
    /* Nothing said and nothing sealed. A provider ends a thinking block with
       one of these, and opening a block on it leaves an unsigned block after
       the signed one: the wire drops what it cannot sign, so the thinking would
       go back to the provider with a hole in it. */
    if (event.text === '' && event.signature === undefined) {
      return held;
    }
    const last = held.thought.at(-1);
    const open = last?.kind === 'reasoning' && last.signature === undefined ? last : undefined;
    const sealed = event.signature;
    const grown: PartDraft = {
      kind: 'reasoning',
      body: (open?.body ?? '') + event.text,
      ...(sealed === undefined ? {} : { signature: sealed }),
    };
    const before = open === undefined ? held.thought : held.thought.slice(0, -1);
    return { ...held, thought: [...before, grown] };
  });

/**
 * Takes the question back out when no answer came.
 *
 * A transcript that ends on an unanswered question sends it again with every
 * later request: the caller pays for it each time, and the model may answer it
 * late, on top of whatever was asked next. Nothing else may have touched the
 * session in between, because one session does one thing at a time — that is
 * what `whileFree` in `ask.ts` holds, for a compaction as much as a question.
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
    spoken: Ref.make(nothingSaid),
    written: Ref.make<readonly Turn[]>([]),
    stop: Ref.make<StopReason>('unknown'),
    rounds: Ref.make(0),
    answered: Ref.make(false),
  });

/** Empties what the last round said, so the next one starts its own turn. */
const nextRound = (exchange: Exchange): Effect.Effect<void> =>
  Ref.set(exchange.spoken, nothingSaid);

/** One piece of the answer's text. The only thing on the per-token path. */
const said = (spoken: Ref.Ref<Spoken>, text: string): Effect.Effect<void> =>
  Ref.update(spoken, held => ({ ...held, text: held.text + text }));

/** One tool the model asked for, kept in the order it asked. */
const called = (spoken: Ref.Ref<Spoken>, call: ToolCall): Effect.Effect<void> => {
  const part: PartDraft = {
    kind: 'toolCall',
    body: call.arguments,
    callId: call.id,
    name: call.name,
  };
  return Ref.update(spoken, held => ({ ...held, calls: [...held.calls, part] }));
};

/** One block of thinking the provider encrypted, kept where it arrived. */
const hidden = (spoken: Ref.Ref<Spoken>, data: string): Effect.Effect<void> => {
  const block: PartDraft = { kind: 'redacted', body: data };
  return Ref.update(spoken, held => ({ ...held, thought: [...held.thought, block] }));
};

export type { Exchange };
export {
  called,
  collect,
  commit,
  endRound,
  exchangeFor,
  hidden,
  nextRound,
  remember,
  rollback,
  said,
  thinking,
};
