/**
 * Proves a session survives filling its own context window.
 *
 * The unit tests script the token counts, so they prove the trigger fires where
 * it is told to. They cannot prove the summary is worth anything. This run
 * plants a fact early, fills the window with unrelated talk, and asks for the
 * fact back after the session has compacted itself.
 *
 * The window is set by the caller rather than the model's real one: filling
 * 200k tokens to test this would cost real money and take an hour. What is
 * live here is the summariser, the prompt it builds, and whether the fact
 * survives the round trip.
 */
import assert from 'node:assert/strict';
import { Effect, Stream } from 'effect';
import { openSession } from '../src/core/run.js';
import type { Turn } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/handle.js';
import { everyShape, kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

/** Small enough that a few turns of chat fill it. */
const contextWindow = 80;

const system = 'You answer briefly and remember what you are told.';

/** The fact the summary has to carry. Nothing else in the run mentions it. */
const secret = 'the vault code is 4417';
const plant = `Remember this for later: ${secret}. Reply with the word: noted`;

/** Filler that is long enough to push the prompt over the window. */
const filler = [
  'Name three colours. One line.',
  'Name three fruits. One line.',
  'Name three cities. One line.',
];

const recall = 'What was the vault code I gave you? Answer with the number only.';

/**
 * One question, keeping what it said and what the `done` event reported.
 *
 * The counts matter here: added up they are every call the caller made, so
 * `session.usage` above them is the summary call, which the caller never made
 * and is still billed for.
 */
const say = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text, { maxTokens: 200 }), { said: '', output: 0 }, (held, event) => {
    if (event.kind === 'delta') {
      return { ...held, said: held.said + event.text };
    }
    return event.kind === 'done'
      ? { ...held, output: held.output + event.usage.outputTokens }
      : held;
  });
const layers = kilo({ apiKinds: everyShape, contextWindow });

const program = Effect.gen(function* () {
  const session = yield* openSession({ system, model });
  let asked = 0;
  asked += (yield* say(session, plant)).output;
  for (const question of filler) {
    asked += (yield* say(session, question)).output;
  }
  const last = yield* say(session, recall);
  asked += last.output;
  return {
    answer: last.said,
    asked,
    history: yield* session.history,
    used: yield* session.usage,
  };
});

const result = await Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));

const turns = result.history;
const isSummary = (turn: Turn): boolean => turn.parts.some(part => part.kind === 'summary');
const summaries = turns.filter(isSummary);
const summary = summaries[0]?.parts[0]?.body ?? '';

console.log('model      ', model);
console.log('window     ', contextWindow, 'tokens');
console.log('turns kept ', turns.length);
console.log('summaries  ', summaries.length);
console.log('summary    ', JSON.stringify(summary.slice(0, 160)));
console.log('recalled   ', JSON.stringify(result.answer));
console.log(
  'output used',
  result.used.outputTokens,
  'of which the questions asked for',
  result.asked
);

const failures: string[] = [];

if (summaries.length === 0) {
  failures.push(
    'the session never compacted, so this run proves nothing; lower the window or add filler'
  );
}
if (!summary.includes('4417')) {
  /* The strongest of the three. It reads the summary itself, rather than an
     answer the model could have reached another way. */
  failures.push(
    'the summary does not carry the fact, so the summariser dropped what a later turn needed'
  );
}
if (turns.findIndex(isSummary) === 0) {
  failures.push('the summary is the first turn, so nothing was summarised');
}
if (result.used.outputTokens <= result.asked) {
  /* Every `done` event added up is what the questions cost. The session's own
     total has to be larger, because it also holds the summary call, which the
     caller never asked for and is billed for all the same. */
  failures.push(
    `the counts leave out the summary call: the session reports ` +
      `${String(result.used.outputTokens)} output tokens and the questions alone ` +
      `account for ${String(result.asked)}`
  );
}
if (!result.answer.includes('4417')) {
  failures.push(
    `the fact did not survive the summary: the model answered ${JSON.stringify(result.answer)}, ` +
      'so the summariser dropped what a later turn needed'
  );
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log('\nPASS: the session compacted itself and kept what it was told.');
