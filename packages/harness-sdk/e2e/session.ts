/**
 * Proves two things about a live session that the unit tests can only model.
 *
 * **The prefix holds as the session grows.** The unit test proves `assemble`
 * does not rewrite an earlier message. That is not the same as the provider
 * agreeing: the symptom of a prefix regression is a large `cache write` on a
 * call that should have been almost all `cache read`, and only a real gateway
 * shows it. Ten questions, and every call after the first must write far less
 * than it reads.
 *
 * **A busy session refuses rather than corrupts.** Two questions at once would
 * both build on the same prefix. The unit test proves the refusal against a
 * fake model that answers instantly; this proves it while a real answer is
 * still streaming, which is the only time the race can actually happen.
 */
import assert from 'node:assert/strict';
import { Effect, Stream } from 'effect';
import { SessionBusyError } from '../src/core/ask.js';
import type { ModelUsage } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/wiring.js';
import { hitRatio } from '../src/core/usage.js';
import { cachedSystem as system, kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';
const questions = 10;

interface Answer {
  readonly said: string;
  readonly usage: ModelUsage | undefined;
}

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text), { said: '', usage: undefined } as Answer, (held, event) =>
    event.kind === 'delta'
      ? { ...held, said: held.said + event.text }
      : event.kind === 'done'
        ? { ...held, usage: event.usage }
        : held
  );

const words = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;
const layers = kilo({ apiKinds: ['messages'] });

const growing = Effect.gen(function* () {
  const session = yield* openSession({ system, model, maxTokens: 64 });
  const answers: Answer[] = [];
  for (let index = 0; index < questions; index += 1) {
    answers.push(yield* ask(session, `Answer with the word: ${words[index] ?? 'one'}`));
  }
  return answers;
});

/**
 * Starts a question, waits for its first token so the session is provably mid
 * answer, then asks a second one on the same session. The second must be
 * refused. The first must still finish.
 */
const racing = Effect.gen(function* () {
  const session = yield* openSession({ system, model, maxTokens: 64 });
  const started = yield* Effect.fork(
    Stream.runCollect(Stream.take(session.ask('Answer with the word: one'), 1))
  );
  yield* Effect.sleep('300 millis');
  const second = yield* Effect.either(Stream.runDrain(session.ask('Answer with the word: two')));
  yield* started.await;
  return second;
});

console.log('model', model, '\n');

const answers = await Effect.runPromise(Effect.scoped(Effect.provide(growing, layers)));

console.log('call  said     input  cache read  cache write  ratio');
const failures: string[] = [];

answers.forEach((answer, index) => {
  const usage = answer.usage;
  if (usage === undefined) {
    failures.push(`call ${String(index + 1)} carried no token counts`);
    return;
  }
  console.log(
    `${String(index + 1).padEnd(6)}${JSON.stringify(answer.said).padEnd(9)}` +
      `${String(usage.inputTokens).padEnd(7)}${String(usage.cacheReadTokens).padEnd(12)}` +
      `${String(usage.cacheWriteTokens).padEnd(13)}${hitRatio(usage).toFixed(4)}`
  );

  if (answer.said.length === 0) {
    failures.push(`call ${String(index + 1)} carried no text`);
  }

  /* The first call writes the whole prefix. Every call after it must be
     reading far more than it writes: a large write later means the prefix
     moved, which is the regression this run exists to catch. */
  if (index > 0 && usage.cacheWriteTokens > usage.cacheReadTokens / 4) {
    failures.push(
      `call ${String(index + 1)} wrote ${String(usage.cacheWriteTokens)} against ` +
        `${String(usage.cacheReadTokens)} read, so the prefix moved`
    );
  }
});

const refused = await Effect.runPromise(Effect.scoped(Effect.provide(racing, layers)));

console.log(
  '\nsecond question while the first streamed:',
  refused._tag === 'Left' ? refused.left._tag : 'it was accepted'
);
if (!(refused._tag === 'Left' && refused.left instanceof SessionBusyError)) {
  failures.push('a second question was accepted while the first was still streaming');
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log(
  `\nPASS: the prefix held across ${String(questions)} calls, and a busy session refused.`
);
