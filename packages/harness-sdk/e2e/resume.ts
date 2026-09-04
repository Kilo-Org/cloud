/**
 * Proves a reopened session knows how full it is, against a real gateway.
 *
 * The unit tests script the token counts, so they prove the column is written
 * and read. They cannot prove the number written is the one the provider
 * actually reported. This run reads the count off the `done` event, reads the
 * same session back out of SQLite, and compares them.
 *
 * Then it uses that number to pin both directions. A window the count fills
 * must make the reopened session compact before its first question; a window
 * ten times larger must leave it alone. Both windows come from the count the
 * provider gave, so neither depends on a guess about how a model tokenises.
 */
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, Option, Stream } from 'effect';
import { continueSession, type ResumeContext } from '../src/core/resume.js';
import { openSession } from '../src/core/run.js';
import { SessionStore } from '../src/core/storage.js';
import type { Turn } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/handle.js';
import { layerNodeStore } from '../src/plugins/store/node.js';
import { everyShape, kilo, model } from './setup.js';
import { failures, passed } from './report.js';

const system = 'You answer briefly and remember what you are told.';

/** The fact the summary has to carry across the reopen. */
const secret = 'the vault code is 4417';
const plant = `Remember this for later: ${secret}. Reply with the word: noted`;
const recall = 'What was the vault code I gave you? Answer with the number only.';

/** One database, three runs. Each run builds its layers again, as a restart does. */
const database = new DatabaseSync(':memory:');
const store = layerNodeStore(database);

/**
 * Runs one program against that database under a stated window. The window is
 * what varies, because it is the only thing the stored count is measured
 * against.
 */
const under = <A, E>(contextWindow: number, use: Effect.Effect<A, E, ResumeContext>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(use, Layer.mergeAll(kilo({ apiKinds: everyShape, contextWindow }), store))
    )
  );

/** One question, keeping what it said and what the provider counted for it. */
const say = (session: SessionHandle, text: string) =>
  Stream.runFold(
    session.ask(text, { maxTokens: 200 }),
    { said: '', prompted: 0 },
    (held, event) => {
      if (event.kind === 'delta') {
        return { ...held, said: held.said + event.text };
      }
      return event.kind === 'done'
        ? { ...held, prompted: event.usage.inputTokens + event.usage.cacheReadTokens }
        : held;
    }
  );

const isSummary = (turn: Turn): boolean => turn.parts.some(part => part.kind === 'summary');
const summariesIn = (turns: readonly Turn[]): number => turns.filter(isSummary).length;

/**
 * Plants the fact under a window nothing can fill, so this run ends with a
 * count and no summary. Then reads the session back out of the store.
 */
const planted = Effect.gen(function* () {
  const session = yield* openSession({ system, model });
  const answer = yield* say(session, plant);
  const stored = yield* Effect.flatMap(SessionStore, plugin => plugin.read(session.id));
  return {
    id: session.id,
    prompted: answer.prompted,
    stored: Option.getOrUndefined(stored)?.prompted,
    summaries: summariesIn(yield* session.history),
  };
});

/** Reopens the session and asks for the fact back, whatever the window says. */
const reopened = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* continueSession(sessionId);
    const before = summariesIn(yield* session.history);
    const answer = yield* say(session, recall);
    return { said: answer.said, before, after: summariesIn(yield* session.history) };
  });

console.log('model', model, '\n');

const first = await under(1_000_000, planted);

/* The window this session is now measured against. Its own count fills it, so
   a reopened session that reads the count compacts before it asks anything. */
const tight = first.prompted;
const roomy = first.prompted * 10;

const narrow = await under(tight, reopened(first.id));
const wide = await under(roomy, reopened(first.id));

console.log('counted by the provider', first.prompted);
console.log('read back from SQLite  ', first.stored);
console.log('summaries after planting', first.summaries);
console.log(`\nreopened under a window of ${String(tight)}`);
console.log('  summaries before the question', narrow.before, 'after', narrow.after);
console.log('  recalled', JSON.stringify(narrow.said));
console.log(`\nreopened under a window of ${String(roomy)}`);
console.log('  summaries before the question', wide.before, 'after', wide.after);
console.log('  recalled', JSON.stringify(wide.said));

if (first.prompted === 0) {
  failures.push('the provider reported no input tokens, so this run measures nothing');
}
if (first.stored !== first.prompted) {
  failures.push(
    `the store holds ${String(first.stored)} where the provider counted ` +
      `${String(first.prompted)}, so the count did not survive the write`
  );
}
if (first.summaries !== 0) {
  failures.push('the planting run compacted, so what follows is measured against a summary');
}
if (narrow.after <= narrow.before) {
  failures.push(
    'a session reopened onto a conversation that fills its window did not compact, ' +
      'so it started from zero rather than from the stored count'
  );
}
if (!narrow.said.includes('4417')) {
  failures.push(
    `the fact did not survive the reopen and the summary: the model answered ` +
      `${JSON.stringify(narrow.said)}`
  );
}
if (wide.after !== wide.before) {
  /* The other direction. Without it, a session that compacted on every
     question would pass the check above and be worse than the defect. */
  failures.push('a session with room to spare compacted anyway');
}
if (!wide.said.includes('4417')) {
  failures.push(
    `the fact did not survive the reopen: the model answered ${JSON.stringify(wide.said)}`
  );
}

passed('the stored count is the provider’s own, and it decides what happens next.');
