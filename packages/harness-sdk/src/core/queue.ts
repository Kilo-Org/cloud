import { Effect, Queue, Ref } from 'effect';
import type { AskOptions } from './ask.js';
import type { ContinuedError } from './wiring.js';
import type { EntropySourceService } from './entropy.js';
import { makeId } from './id.js';
import type { ModelEvent } from './model.js';
import { type PartDraft, partsOf } from './turn.js';

/**
 * What the session has been given to say and has not said yet.
 *
 * One session does one thing at a time, so anything that arrives while an
 * answer is streaming has to wait somewhere. Two things arrive that way: a
 * message a caller sent while the session was busy, and the result of a tool
 * the model stopped waiting for. Both are the same shape — words to put in
 * front of the model, in a turn of their own — so both wait in one line, and
 * the line is answered in the order it formed.
 *
 * A caller may take a message back out again while it is still waiting. That is
 * the whole of cancelling: a message that has not been sent costs nothing to
 * drop, and one that has been sent cannot be taken back from the provider.
 */

const idPrefix = 'que';

/** What one entry in the line is. `kind` says who put it there. */
interface Waiting {
  readonly id: string;
  /**
   * `message` is a caller's own, and only a caller's own is worth cancelling.
   * `toolResult` is an answer the model is waiting for: cancelling one leaves
   * the model believing a call is still running that nobody will ever report.
   */
  readonly kind: 'message' | 'toolResult';
  /** What the model will read, as the turn it will read it in. */
  readonly parts: readonly PartDraft[];
  /** What the caller asked for this message alone. A tool result names none. */
  readonly options?: AskOptions;
}

/** What every piece of a round names: the entries it is answering. */
interface Answering {
  /**
   * The queued entries this round is answering, in the order they joined the
   * line. One for a message; one or more for tool results that ran together.
   * It is how a caller tells one queued message's answer from another's.
   */
  readonly answering: readonly string[];
}

/**
 * One thing that happened in a round the caller did not ask for.
 *
 * A round either says something or fails, so this is a union rather than a
 * stream that fails. A failed round is one message's bad news and not the end
 * of the feed: the session goes on running rounds for everything else in the
 * line, and a caller who lost the stream to the first refused round would never
 * hear about any of them. Narrow with `'failed' in one`.
 */
type Continued =
  | (Answering & { readonly event: ModelEvent })
  | (Answering & { readonly failed: ContinuedError });

/** The line, the bell that tells the driver something joined it, and the names. */
interface Pending {
  readonly waiting: Ref.Ref<readonly Waiting[]>;
  /**
   * One token per entry added, carrying its identifier. The driver waits on
   * this rather than polling. A token whose entry was cancelled before the
   * driver reached it finds an empty run and starts no round.
   */
  readonly arrived: Queue.Queue<string>;
  /** Where an entry's identifier comes from. The line makes its own names. */
  readonly entropy: EntropySourceService;
}

const makePending = (entropy: EntropySourceService): Effect.Effect<Pending> =>
  Effect.all({
    waiting: Ref.make<readonly Waiting[]>([]),
    arrived: Queue.unbounded<string>(),
    entropy: Effect.succeed(entropy),
  });

/** Joins the line, at the back. The identifier is what cancels it. */
const enqueue = (pending: Pending, entry: Omit<Waiting, 'id'>): Effect.Effect<string> =>
  Effect.flatMap(makeId(pending.entropy, idPrefix), id =>
    Ref.update(pending.waiting, held => [...held, { ...entry, id }]).pipe(
      Effect.zipRight(Queue.offer(pending.arrived, id)),
      Effect.as(id)
    )
  );

/** A caller's message, as a caller writes one. */
const enqueueMessage = (
  pending: Pending,
  input: string | readonly PartDraft[],
  options: AskOptions | undefined
): Effect.Effect<string> =>
  enqueue(pending, {
    kind: 'message',
    parts: partsOf(input),
    ...(options === undefined ? {} : { options }),
  });

/**
 * Takes a message back out of the line.
 *
 * True when it was still there. False when it was not: it has already been
 * asked, or it was never here, and neither is an error — a caller racing their
 * own cancel button against the session losing that race is the ordinary case,
 * not a failure.
 */
const cancelQueued = (pending: Pending, id: string): Effect.Effect<boolean> =>
  Ref.modify(pending.waiting, held => {
    const left = held.filter(one => one.id !== id);
    return [left.length !== held.length, left];
  });

/** How many tool results are waiting at the front, before anything else. */
const resultsAtFront = (held: readonly Waiting[]): number => {
  const ends = held.findIndex(one => one.kind !== 'toolResult');
  return ends === -1 ? held.length : ends;
};

/**
 * The next round's worth of the line.
 *
 * A message is a round of its own: a caller who wrote two of them meant two
 * turns. Tool results run together, as many as are waiting at the front,
 * because the model asked for those calls in one turn and is waiting on all of
 * them — answering them one round at a time would put the model through a
 * request per result and tell it less each time.
 */
const takeRun = (pending: Pending): Effect.Effect<readonly Waiting[]> =>
  Ref.modify(pending.waiting, held => {
    const taken = held[0]?.kind === 'message' ? 1 : resultsAtFront(held);
    return [held.slice(0, taken), held.slice(taken)];
  });

/**
 * Rings the bell again for a line that still holds something.
 *
 * A round the driver gave up on took nothing out of the line, but the token
 * that pointed at it is spent. Without this the entries wait for whatever joins
 * next, which for the last message a caller sends is forever.
 */
const wake = (pending: Pending): Effect.Effect<void> =>
  Effect.flatMap(Ref.get(pending.waiting), held => {
    const [first] = held;
    return first === undefined
      ? Effect.void
      : Effect.asVoid(Queue.offer(pending.arrived, first.id));
  });

export type { Answering, Continued, Pending, Waiting };
export { cancelQueued, enqueue, enqueueMessage, makePending, takeRun, wake };
