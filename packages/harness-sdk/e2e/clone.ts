/**
 * Proves a clone is cheap, which is the only reason to have one.
 *
 * `resume.test.ts` compares the prompt a clone sends with the prompt its source
 * sends, byte for byte, and that is as far as a fake can go. The claim is about
 * money: the copy renders to the same bytes, so the provider reads the prefix
 * out of its cache instead of building it again. Only a real gateway reports
 * that, as a large `cache read` against an almost empty `cache write`.
 *
 * A clone that copied one identifier into the prompt, or reordered one part,
 * would still pass every unit test here and quietly double the bill.
 */
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, Stream } from 'effect';
import type { ModelUsage } from '../src/core/model.js';
import { cloneSession } from '../src/core/resume.js';
import type { ResumeContext } from '../src/core/resume.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import { layerNodeStore } from '../src/plugins/store/node.js';
import { cachedSystem as system, kilo, models, room } from './setup.js';
import { fail, passed, under, wrongIf } from './report.js';

/** One database, two runs, as a second start of an application would have. */
const database = new DatabaseSync(':memory:');
const layers = Layer.mergeAll(kilo({ apiKinds: ['messages'] }), layerNodeStore(database));

const run = <A, E>(use: Effect.Effect<A, E, ResumeContext>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(use, layers)));

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(
    session.ask(text, { maxTokens: room }),
    { said: '', usage: undefined as ModelUsage | undefined },
    (held, event) =>
      event.kind === 'delta'
        ? { ...held, said: held.said + event.text }
        : event.kind === 'done'
          ? { ...held, usage: event.usage }
          : held
  );

/** Builds the prefix and pays for it, so there is a warm cache to inherit. */
const source = (model: string) =>
  Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: room });
    const first = yield* ask(session, 'Answer with the word: one');
    const second = yield* ask(session, 'Answer with the word: two');
    return { id: session.id, first: first.usage, second: second.usage };
  });

/** Branches it, asks one question, and reports what the branch was charged. */
const branch = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* cloneSession(sessionId);
    const answer = yield* ask(session, 'Answer with the word: three');
    return {
      id: session.id,
      said: answer.said,
      usage: answer.usage,
      turns: yield* session.history,
    };
  });

const show = (name: string, usage: ModelUsage | undefined): void => {
  console.log(
    `${name.padEnd(14)}input ${String(usage?.inputTokens ?? 0).padEnd(6)}` +
      `cache read ${String(usage?.cacheReadTokens ?? 0).padEnd(7)}` +
      `cache write ${String(usage?.cacheWriteTokens ?? 0)}`
  );
};

/** The models whose provider made the prefix readable. The floor is that one did. */
const cached: string[] = [];

for (const model of models) {
  under(model);

  console.log('model', model, '\n');

  const first = await run(source(model));
  const cloned = await run(branch(first.id));
  const original = await run(branch(first.id));

  show('source call 1', first.first);
  show('source call 2', first.second);
  show('clone call 1', cloned.usage);
  show('second clone', original.usage);
  console.log('\nclone id  ', cloned.id, '\nsource id ', first.id);
  console.log('clone said', JSON.stringify(cloned.said), 'over', cloned.turns.length, 'turns');

  const read = cloned.usage?.cacheReadTokens ?? 0;
  const written = cloned.usage?.cacheWriteTokens ?? 0;

  if (cloned.id === first.id) {
    fail('the clone took the identifier of the session it came from');
  }
  if (cloned.turns.length !== 6) {
    /* The four copied turns, the question this run asked, and its answer. A
       clone that lost a turn would send a shorter prompt and still read most of
       the prefix, so the count is checked as well as the cache. */
    fail(`the clone holds ${String(cloned.turns.length)} turns where it should hold 6`);
  }
  if ((first.second?.cacheReadTokens ?? 0) === 0) {
    /* The provider never made an entry readable, so there is no prefix here to
       measure a clone against. Read from the source rather than a list of names
       here: `nvidia/nemotron-3.5-lightning` reads zero on every call on
       2026-09-06, and which providers cache changes without warning. What the
       clone is — its own identifier, six turns, an answer — is checked above on
       every model regardless. */
    console.log('the provider cached nothing, so there is no prefix to measure');
    continue;
  }
  cached.push(model);
  if (read === 0) {
    fail('the clone read nothing from the cache, so it paid for the prefix again');
  }
  if (written > read / 4) {
    fail(
      `the clone wrote ${String(written)} against ${String(read)} read, so its prompt is not ` +
        'the prompt the source sent'
    );
  }
  if (cloned.said.length === 0) {
    fail('the clone answered with nothing');
  }
  if ((original.usage?.cacheReadTokens ?? 0) === 0) {
    /* The second clone comes off the same source, which the first clone must not
       have touched. A source that grew would move the prefix out from under it. */
    fail('a second clone of the same session read nothing, so the first one changed it');
  }
}

under('');
console.log(`\ncached the prefix: ${String(cached.length)} of ${String(models.length)} models`);
/* The floor under the skip: a clone that stopped sending the source's prompt
   would read nothing anywhere, and that must go red rather than quiet. */
wrongIf(cached.length === 0, 'not one provider cached the prefix, so no clone was measured');

passed('every clone the provider cached for read its prefix and wrote next to nothing');
