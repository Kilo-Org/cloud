/**
 * Proves a real call stops when the caller stops listening.
 *
 * `cancel.test.ts` proves the same thing against a fake `fetch`. A fake cannot
 * show what a real socket does: whether the abort reaches undici, whether the
 * reader throws where nothing catches it, whether the session is still usable
 * after. So this run asks a model for a long answer twice, reads one to the
 * end, and walks away from the other.
 *
 * What it proves: the client stops early, and the session survives it.
 * What it cannot prove: that the provider stops generating and stops charging.
 * Nothing this package can read reports that.
 */
import assert from 'node:assert/strict';
import { Duration, Effect, Fiber, Layer, Ref, Stream } from 'effect';
import type { AbortLike, FetchLike } from '../src/core/fetch.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/wiring.js';
import { kilo } from './setup.js';
import { nodeFetch } from './node-fetch.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

const system = 'You do exactly what you are told, at length, with no preamble.';
const long = 'Count from 1 to 300. Put one number on each line. Do not stop early.';

/**
 * How much of the answer the cancelled run reads before it walks away. It
 * waits for pieces rather than for a clock: the interesting case is a caller
 * who leaves mid-stream, and a fixed wait shorter than the time to the first
 * piece would only ever cancel a request that had not started answering.
 */
const readBeforeLeaving = 10;

/** An unhandled rejection is the live-only failure a fake `fetch` cannot show. */
const loose: unknown[] = [];
process.on('unhandledRejection', reason => loose.push(reason));

/** Records the signal of every call, so the run can read it afterwards. */
const signals: (AbortLike | undefined)[] = [];
const watchedFetch: FetchLike = (url, request) => {
  signals.push(request.signal);
  return nodeFetch(url, request);
};

const layers = kilo({ apiKinds: ['messages'] }, { fetch: watchedFetch });

/** Counts the pieces of the answer, whether it finishes or is walked away from. */
const counted = (session: SessionHandle, said: Ref.Ref<number>) =>
  session.ask(long, { maxTokens: 1500 }).pipe(
    Stream.tap(event =>
      event.kind === 'delta' ? Ref.update(said, held => held + 1) : Effect.void
    ),
    Stream.runDrain
  );

const since = (start: number) => Date.now() - start;

/** Waits until the answer has produced `target` pieces, or gives up. */
const until = (said: Ref.Ref<number>, target: number) =>
  Ref.get(said).pipe(
    Effect.delay(Duration.millis(20)),
    Effect.repeat({ until: (held: number) => held >= target }),
    Effect.timeoutFail({
      duration: Duration.seconds(30),
      onTimeout: () => new Error(`the answer never reached ${String(target)} pieces`),
    })
  );

const program = Effect.gen(function* () {
  const session = yield* openSession({ system, model });

  /* The baseline. It says how long the whole answer takes, so the cancelled
     run has something to be measured against. */
  const whole = yield* Ref.make(0);
  const started = Date.now();
  yield* counted(session, whole);
  const wholeMillis = since(started);

  const cut = yield* Ref.make(0);
  const cutSession = yield* openSession({ system, model });
  const cutStarted = Date.now();
  const reading = yield* Effect.fork(counted(cutSession, cut));
  yield* until(cut, readBeforeLeaving);
  yield* Fiber.interrupt(reading);
  const cutMillis = since(cutStarted);

  return {
    whole: { said: yield* Ref.get(whole), millis: wholeMillis },
    cut: { said: yield* Ref.get(cut), millis: cutMillis },
    /* An interrupted exchange leaves nothing: the answer never arrived, and
       the question goes back out with it. */
    history: yield* cutSession.history,
    /* The session must still work: a `busy` flag left set would strand it. */
    after: yield* Stream.runFold(
      cutSession.ask('Answer with the word: ok', { maxTokens: 16 }),
      '',
      (held, event) => (event.kind === 'delta' ? held + event.text : held)
    ),
  };
});

const result = await Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));

const roles = result.history.map(turn => turn.role);

console.log('model         ', model);
console.log('whole answer  ', result.whole.said, 'pieces in', result.whole.millis, 'ms');
console.log('walked away   ', result.cut.said, 'pieces in', result.cut.millis, 'ms');
console.log('turns kept    ', JSON.stringify(roles));
console.log('asked again   ', JSON.stringify(result.after));
console.log('signals       ', signals.map(signal => signal?.aborted ?? 'none').join(' '));
console.log('loose errors  ', loose.length);

const failures: string[] = [];

if (result.whole.said === 0) {
  failures.push('the baseline answer carried no text, so there is nothing to compare against');
}
if (result.whole.said < readBeforeLeaving * 2) {
  failures.push(
    `the whole answer had ${String(result.whole.said)} pieces, which is too few to tell a ` +
      'cancelled run from a finished one; ask for a longer answer'
  );
}
if (result.cut.said < readBeforeLeaving) {
  failures.push(
    `the cancelled run read ${String(result.cut.said)} pieces, so it never got mid-stream and ` +
      'the run only cancelled a request that had not started answering'
  );
}
if (result.cut.said >= result.whole.said) {
  failures.push(
    `the cancelled run read ${String(result.cut.said)} pieces and the whole answer had ` +
      `${String(result.whole.said)}, so nothing was cut short`
  );
}
if (!signals.every(signal => signal?.aborted === true)) {
  failures.push('a call ended with its signal not aborted, so the socket was left open');
}
if (roles.length !== 0) {
  failures.push(
    `the cancelled session kept ${JSON.stringify(roles)}; an interrupted exchange must leave ` +
      'nothing, because a half written answer poisons the prefix and an unanswered question ' +
      'goes back out with every later request'
  );
}
if (result.after.length === 0) {
  failures.push('the session could not be asked again after the cancellation');
}
if (loose.length > 0) {
  failures.push(
    `the abort left ${String(loose.length)} unhandled rejection(s): ${String(loose[0])}`
  );
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log('\nPASS: the call stopped when the caller did, and the session survived it.');
