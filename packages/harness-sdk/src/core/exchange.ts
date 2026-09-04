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

/** What is collected while the reply streams, to become the assistant's turn. */
interface Spoken {
  readonly text: Ref.Ref<string>;
  readonly reasoning: Ref.Ref<string>;
  /** Empty when the shape issues none, or when the model did not think. */
  readonly signature: Ref.Ref<string>;
  /** Thinking the provider encrypted, in the order it arrived. */
  readonly redacted: Ref.Ref<readonly string[]>;
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
  readonly redacted: readonly string[];
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
  const hidden = thought.redacted.map((data): PartDraft => ({ kind: 'redacted', body: data }));
  if (thought.body === '' && thought.signature === '') {
    return [...hidden, answer];
  }
  return [
    ...hidden,
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
    redacted: Ref.get(exchange.spoken.redacted),
  }).pipe(
    Effect.flatMap(({ said, ...thought }) =>
      makeTurn(wiring.entropy, {
        sessionId: wiring.id,
        role: 'assistant',
        parts: partsSaid(said, thought),
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
      redacted: Ref.make<readonly string[]>([]),
    }),
    answered: Ref.make(false),
  });

export type { Exchange, Spoken };
export { exchangeFor, finish, remember, rollback, thinking };
