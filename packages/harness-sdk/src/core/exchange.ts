import { Effect, Ref } from 'effect';
import { promptedOf } from './compact.js';
import type { ModelEvent, ModelUsage } from './model.js';
import { appendTurn, type Session } from './session.js';
import { onStore, type StoreError } from './storage.js';
import { makeTurn, partsOf, type PartDraft, type Turn } from './turn.js';
import { add } from './usage.js';
import type { Wiring } from './wiring.js';

/**
 * One question and the answer it is waiting for.
 *
 * A question and its answer are written together or not at all. Half of an
 * exchange is worse than none: a transcript that ends on an unanswered
 * question sends it again with every later request, the caller pays for it
 * each time, and the model may answer it late on top of whatever was asked
 * next. So the turn goes into the session as the question is asked, into the
 * store only when the answer arrives, and back out again when it does not.
 *
 * What drives the stream is `ask.ts`.
 */

/** Adds a turn to the session in memory. The store hears at the end of the exchange. */
const remember = (wiring: Wiring, turn: Turn): Effect.Effect<void> =>
  Ref.update(wiring.state, session => appendTurn(session, turn));

/**
 * What is collected while the reply streams, to become the assistant's turn.
 *
 * One record rather than a ref per field. Copying the other on every token
 * costs 0.054 us against 0.402 for the update alone, measured 2026-09-04 over
 * 200000 rounds, which is a third of a percent of the 18.1 us a token costs
 * through the whole session. `finish` reads it once.
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
}

const nothingSaid: Spoken = { text: '', thought: [] };

interface Exchange {
  readonly question: Turn;
  readonly spoken: Ref.Ref<Spoken>;
  /** True once the answer arrived. See `rollback`. */
  readonly answered: Ref.Ref<boolean>;
  /** The session as it stood before the question, to go back to. */
  readonly before: Session;
}

/**
 * The thinking comes first, in the order the model produced it, and the answer
 * last. A reasoning block is kept even with no words: a provider that returns
 * the thinking as a summary defaults to no summary at all, so the block is
 * empty and still has to go back exactly as it came.
 *
 * The text part is always there: an answer of no words is still an answer, and
 * a turn with no text would shorten the prompt that follows.
 */
const partsSaid = (spoken: Spoken): readonly PartDraft[] => [
  ...spoken.thought,
  { kind: 'text', body: spoken.text },
];

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
  Ref.get(exchange.spoken).pipe(
    Effect.flatMap(spoken =>
      makeTurn(wiring.entropy, {
        sessionId: wiring.id,
        role: 'assistant',
        parts: partsSaid(spoken),
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
 * Collects one thinking event into the block it belongs to.
 *
 * The words and the signature arrive on separate events, so both land on the
 * block still open. A block stays open until something else arrives: an
 * encrypted block closes it, and the next thinking event opens a new one.
 *
 * ponytail: a signature closes nothing here, so two signed blocks in a row
 * merge into one. A model only produces those between tool calls, which this
 * package does not have yet. Split on the signature when it does.
 */
const thinking = (
  spoken: Ref.Ref<Spoken>,
  event: Extract<ModelEvent, { kind: 'reasoning' }>
): Effect.Effect<void> =>
  Ref.update(spoken, held => {
    const open = held.thought.at(-1);
    const sealed = event.signature ?? (open?.kind === 'reasoning' ? open.signature : undefined);
    const grown: PartDraft = {
      kind: 'reasoning',
      body: (open?.kind === 'reasoning' ? open.body : '') + event.text,
      ...(sealed === undefined ? {} : { signature: sealed }),
    };
    const before = open?.kind === 'reasoning' ? held.thought.slice(0, -1) : held.thought;
    return { ...held, thought: [...before, grown] };
  });

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
    spoken: Ref.make(nothingSaid),
    answered: Ref.make(false),
  });

/** One piece of the answer's text. The only thing on the per-token path. */
const said = (spoken: Ref.Ref<Spoken>, text: string): Effect.Effect<void> =>
  Ref.update(spoken, held => ({ ...held, text: held.text + text }));

/** One block of thinking the provider encrypted, kept where it arrived. */
const hidden = (spoken: Ref.Ref<Spoken>, data: string): Effect.Effect<void> => {
  const block: PartDraft = { kind: 'redacted', body: data };
  return Ref.update(spoken, held => ({ ...held, thought: [...held.thought, block] }));
};

export type { Exchange, Spoken };
export { exchangeFor, finish, hidden, remember, rollback, said, thinking };
