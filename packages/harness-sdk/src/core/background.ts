import { Chunk, Duration, Effect, PubSub, Queue, Schedule, Stream, Take } from 'effect';
import { askWith, SessionBusyError } from './ask.js';
import type { ModelEvent } from './model.js';
import type { LateResult } from './tool.js';
import type { PartDraft } from './turn.js';
import type { ContinuedError, Wiring } from './wiring.js';

/**
 * What the session does when a backgrounded call finally answers.
 *
 * The model was told the call was still running and carried on. The answer
 * cannot go back as a tool result: the call it belongs to was already answered,
 * and every shape refuses a second result for one call. So it goes back as
 * something the conversation says, in a turn of its own, and the session asks
 * the model about it without anybody having asked a question.
 *
 * That is the difference between this and waiting for the next question. A
 * harness that finishes a build in the background, or asks a person something
 * and gets an answer ten minutes later, has work to do at that moment and not
 * at whatever moment somebody next types. The session drives itself, and a
 * caller watches through `session.continued`.
 */

/** How the answer reads to the model when it arrives out of turn. */
const lateText = (late: LateResult): string =>
  `The ${late.call.name} call you made earlier (id ${late.call.id}) has ` +
  `${late.result.failed ? 'failed' : 'finished'}:\n\n${late.result.body}`;

const partsOf = (late: readonly LateResult[]): readonly PartDraft[] =>
  late.map(one => ({ kind: 'text', body: lateText(one) }));

/**
 * How long to wait before trying again when a question is already streaming.
 *
 * One session does one thing at a time, so a result that lands mid-question
 * waits for it. Nothing is lost by waiting: the results are already in hand,
 * and the round they start is built fresh on each attempt.
 */
const whenBusy = Schedule.spaced(Duration.millis(50)).pipe(Schedule.upTo(Duration.minutes(5)));

/** Everything waiting now, so a burst of results becomes one round, not several. */
const waiting = (wiring: Wiring): Effect.Effect<readonly LateResult[]> =>
  Effect.zipWith(Queue.take(wiring.late), Queue.takeAll(wiring.late), (first, rest) => [
    first,
    ...Chunk.toReadonlyArray(rest),
  ]);

/**
 * One self-driven round: the results go in as a turn, the model answers, and
 * everything it says reaches whoever is watching.
 *
 * The round is retried while the session is busy and given up on when the model
 * or the store refuses it. The failure reaches the watcher, which ends that
 * subscription and not the session: reading `session.continued` again starts a
 * new one, and the next backgrounded call still drives a round of its own.
 */
const roundFor = (wiring: Wiring, late: readonly LateResult[]): Effect.Effect<void> =>
  Stream.runForEach(askWith(wiring)(partsOf(late)), event =>
    PubSub.publish(wiring.continued, Take.of<ModelEvent>(event))
  ).pipe(
    Effect.retry({
      while: (refused: ContinuedError) => refused instanceof SessionBusyError,
      schedule: whenBusy,
    }),
    Effect.catchAll(refused => Effect.asVoid(PubSub.publish(wiring.continued, Take.fail(refused))))
  );

/**
 * Waits on the queue for as long as the session lives.
 *
 * Forked into the session's own scope, so it stops when the session closes and
 * runs whether or not anybody is watching. A backgrounded call that nobody
 * listens for still gets answered; only the events go unseen.
 */
const driveLate = (wiring: Wiring): Effect.Effect<void> =>
  Effect.forever(Effect.flatMap(waiting(wiring), late => roundFor(wiring, late)));

/** What a caller reads to see the rounds it did not ask for. */
const continuedOf = (wiring: Wiring): Stream.Stream<ModelEvent, ContinuedError> =>
  Stream.flattenTake(Stream.fromPubSub(wiring.continued));

export { continuedOf, driveLate, lateText };
