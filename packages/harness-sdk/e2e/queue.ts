/**
 * Proves the line: a message handed over while the session is busy, the one
 * taken back before it is said, and the order both are answered in.
 *
 * A fake proves the line forms. Only the provider proves the line is a
 * conversation: a queued message is answered from the same transcript, in the
 * order it joined, and the answer names which message it answers. That is the
 * whole promise of `queue`, and none of it can be seen without a model that
 * remembers what it just said.
 *
 * One session, three questions:
 *
 * - **Handed over while busy.** Two messages are queued from inside the first
 *   answer's own stream, which is the only moment the session is certainly
 *   held. Neither refuses.
 * - **Taken back.** A third is queued between them and cancelled while it is
 *   still waiting. It is never asked, and cancelling it twice says so.
 * - **Answered in order, from the transcript.** The first queued message asks
 *   the model to repeat the word it just said, so an answer carrying that word
 *   proves the round ran in this session and not beside it.
 */
import assert from 'node:assert/strict';
import { Effect, Stream } from 'effect';
import type { SessionHandle } from '../src/core/handle.js';
import type { ModelEvent } from '../src/core/model.js';
import type { Continued, Waiting } from '../src/core/queue.js';
import { openSession } from '../src/core/run.js';
import { kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

/* Terse, and told to repeat itself when asked. The transcript test turns on
   the model saying a word back, and a prompt that forbids it would fail the
   run for the prompt rather than for the line. */
const system =
  'You are a test harness. Answer every message with one lowercase word and ' +
  'nothing else. If the user asks for the word you last answered, answer with ' +
  'that same word again.';

const opening = "Answer with the word 'ferret'.";
const repeating = 'Answer with the word you last answered.';
const dropped = "Answer with the word 'pangolin'.";
const closing = "Answer with the word 'badger'.";

/** What one round the session ran on its own said, and which message it answers. */
interface Round {
  readonly answering: readonly string[];
  readonly text: string;
}

const textOf = (waiting: Waiting): string =>
  waiting.parts.map(part => (part.kind === 'text' ? part.body : '')).join('');

/**
 * Everything the caller learns while the first answer is still arriving. It is
 * gathered there because that is the one moment the session is certainly busy,
 * which is the moment `queue` exists for.
 */
interface Handed {
  readonly first: string;
  readonly second: string;
  readonly waiting: readonly Waiting[];
  readonly tookBack: boolean;
  readonly twice: boolean;
}

const handOver = (session: SessionHandle) =>
  Effect.gen(function* () {
    const first = yield* session.queue(repeating);
    const drop = yield* session.queue(dropped);
    const second = yield* session.queue(closing);
    /* Read the line before anything leaves it: this is what a caller draws. */
    const waiting = yield* session.queued;
    const tookBack = yield* session.cancel(drop);
    /* A caller pressing cancel twice is ordinary, and the second is not an error. */
    const twice = yield* session.cancel(drop);
    return { first, second, waiting, tookBack, twice };
  });

/** Asks the opening question, and hands two more over from inside its stream. */
const askAndHand = (session: SessionHandle) =>
  Effect.gen(function* () {
    const held = { text: '', handed: undefined as Handed | undefined };
    const onEvent = (event: ModelEvent) =>
      Effect.gen(function* () {
        if (event.kind === 'delta') {
          held.text += event.text;
        }
        /* Once, on the first event of the stream: from here the session is
           certainly held, which is the state `queue` is for. */
        if (held.handed === undefined) {
          held.handed = yield* handOver(session);
        }
      });
    yield* Stream.runForEach(session.ask(opening), onEvent);
    return { said: held.text, handed: held.handed };
  });

/** Collects the rounds the session runs on its own, until `count` have ended. */
const watch = (session: SessionHandle, count: number) => {
  const rounds: Round[] = [];
  let ended = 0;
  const held = { answering: [] as readonly string[], text: '' };
  return Stream.runForEach(
    Stream.takeUntil(session.continued, one => one.event.kind === 'done' && ++ended === count),
    (one: Continued) =>
      Effect.sync(() => {
        held.answering = one.answering;
        if (one.event.kind === 'delta') {
          held.text += one.event.text;
        }
        if (one.event.kind === 'done') {
          rounds.push({ answering: held.answering, text: held.text });
          held.text = '';
        }
      })
  ).pipe(Effect.as(rounds));
};

const program = Effect.gen(function* () {
  const session = yield* openSession({
    system,
    model,
    maxTokens: 64,
  });
  /* Watch first. The rounds run whether or not anybody listens. */
  const watching = yield* Effect.fork(Effect.timeout(watch(session, 2), '120 seconds'));
  const { said, handed } = yield* askAndHand(session);
  const rounds = yield* watching.await;
  return {
    said,
    handed,
    rounds,
    left: yield* session.queued,
    history: yield* session.history,
  };
});

const got = await Effect.runPromise(Effect.scoped(Effect.provide(program, kilo())));

const failures: string[] = [];
const wrongIf = (broken: boolean, why: string): void => {
  if (broken) {
    failures.push(why);
  }
};

const { handed } = got;
const rounds = got.rounds._tag === 'Success' ? got.rounds.value : [];
const spoken = got.history
  .filter(turn => turn.role === 'user')
  .map(turn => turn.parts.map(part => part.body).join(''));

console.log('model', model);
console.log(`\nasked while free:  ${JSON.stringify(got.said.trim())}`);
for (const [at, round] of rounds.entries()) {
  console.log(`round ${String(at + 1)} answered:  ${JSON.stringify(round.text.trim())}`);
}
console.log(`\nwaiting while busy: ${JSON.stringify((handed?.waiting ?? []).map(textOf))}`);
console.log(`took one back: ${String(handed?.tookBack)}, and again: ${String(handed?.twice)}`);
console.log(`left in the line: ${String(got.left.length)}`);
console.log(`what the session was asked: ${JSON.stringify(spoken)}`);

if (handed === undefined) {
  failures.push('the first answer streamed no event, so nothing was ever handed over');
}

wrongIf(!got.said.toLowerCase().includes('ferret'), 'the first answer was not the word asked for');
wrongIf(
  (handed?.waiting ?? []).length !== 3,
  `the line held ${String((handed?.waiting ?? []).length)} messages while busy, not three`
);
wrongIf(
  JSON.stringify((handed?.waiting ?? []).map(textOf)) !==
    JSON.stringify([repeating, dropped, closing]),
  'the line was not in the order it formed'
);
wrongIf(handed?.tookBack !== true, 'cancelling a waiting message did not take it back');
wrongIf(handed?.twice !== false, 'cancelling the same message twice said it took it back again');
wrongIf(got.rounds._tag !== 'Success', 'the session never finished two rounds of its own');
wrongIf(rounds.length !== 2, `the session ran ${String(rounds.length)} rounds of its own, not two`);
wrongIf(
  !(rounds[0]?.text ?? '').toLowerCase().includes('ferret'),
  'the first queued message was not answered from this session’s transcript'
);
wrongIf(
  !(rounds[1]?.text ?? '').toLowerCase().includes('badger'),
  'the second queued message was not answered'
);
wrongIf(
  rounds[0]?.answering[0] !== handed?.first || rounds[1]?.answering[0] !== handed?.second,
  'a round did not name the message it answers'
);
wrongIf(
  spoken.some(text => text.includes('pangolin')),
  'the cancelled message was said to the model anyway'
);
wrongIf(
  JSON.stringify(spoken) !== JSON.stringify([opening, repeating, closing]),
  'the session was not asked the three messages, in the order they joined'
);
wrongIf(got.left.length !== 0, 'the line still holds a message the session never asked');

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log(
  '\nPASS: two messages were handed over while busy, one was taken back, and the ' +
    'rest were answered in order from the same transcript.'
);
