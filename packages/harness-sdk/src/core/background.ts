import { Duration, Effect, PubSub, Queue, Schedule, Stream, Take } from 'effect';
import { askHeld, SessionBusyError, whileFree } from './ask.js';
import type { ModelError, ModelEvent } from './model.js';
import { type Continued, takeRun, type Waiting } from './queue.js';
import type { StoreError } from './storage.js';
import type { ContinuedError, Wiring } from './wiring.js';

/**
 * What the session says when nobody is streaming an answer out of it.
 *
 * Two things reach the model this way. A message a caller queued while the
 * session was busy, and the result of a tool the model stopped waiting for. The
 * second cannot go back as a tool result: the call it belongs to was already
 * answered, and every shape refuses a second result for one call. So it goes
 * back as something the conversation says, in a turn of its own.
 *
 * Either way the session asks the model without anybody having asked a
 * question, and a caller watches through `session.continued`. That is the
 * difference between this and waiting for the next question: a build that
 * finishes, a person who answers ten minutes later, a message typed while the
 * last answer was still arriving — each is work to do at that moment, not at
 * whatever moment somebody next types.
 */

/**
 * How long to wait before trying again when a question is already streaming.
 *
 * One session does one thing at a time, so a round that is ready mid-question
 * waits for it. Nothing is lost by waiting: what it will say is already in
 * hand, and the round is built fresh on each attempt.
 */
const whenBusy = Schedule.spaced(Duration.millis(50)).pipe(Schedule.upTo(Duration.minutes(5)));

const partsIn = (run: readonly Waiting[]) => run.flatMap(one => one.parts);

const idsIn = (run: readonly Waiting[]) => run.map(one => one.id);

/**
 * One round: what waited goes in as a turn, the model answers, and everything
 * it says reaches whoever is watching.
 *
 * The session is held before anything is taken out of the line, and for the
 * whole round. That order is the point. Taking first and then finding the
 * session busy would leave a message neither waiting nor asked, so a caller
 * looking at `queued` would not see it and `cancel` would say it was too late
 * while nothing had been sent.
 */
const attempt = (wiring: Wiring): Effect.Effect<void, ContinuedError> =>
  whileFree(
    wiring,
    Effect.flatMap(takeRun(wiring.pending), (run): Effect.Effect<void, ModelError | StoreError> => {
      const answering = idsIn(run);
      const publish = (event: ModelEvent) =>
        PubSub.publish(wiring.continued, Take.of<Continued>({ answering, event }));
      /* An empty run is what a cancelled message leaves behind. It starts no
         round rather than asking the model nothing at all. */
      return run.length === 0
        ? Effect.void
        : Stream.runForEach(askHeld(wiring)(partsIn(run), run[0]?.options), publish);
    })
  );

/**
 * Waits on the line for as long as the session lives.
 *
 * Forked into the session's own scope, so it stops when the session closes and
 * runs whether or not anybody is watching. A queued message that nobody listens
 * for is still asked; only the events go unseen, and the transcript holds them.
 *
 * A round is retried while the session is busy and given up on when the model
 * or the store refuses it. The failure reaches the watcher, which ends that
 * subscription and not the session: reading `session.continued` again starts a
 * new one, and the next thing to join the line still gets its round.
 */
const drivePending = (wiring: Wiring): Effect.Effect<void> =>
  Effect.forever(
    Effect.zipRight(
      Queue.take(wiring.pending.arrived),
      attempt(wiring).pipe(
        Effect.retry({
          while: (refused: ContinuedError) => refused instanceof SessionBusyError,
          schedule: whenBusy,
        }),
        Effect.catchAll(refused =>
          Effect.asVoid(PubSub.publish(wiring.continued, Take.fail(refused)))
        )
      )
    )
  );

/** What a caller reads to see the rounds it did not ask for. */
const continuedOf = (wiring: Wiring): Stream.Stream<Continued, ContinuedError> =>
  Stream.flattenTake(Stream.fromPubSub(wiring.continued));

export { continuedOf, drivePending };
