/**
 * Proves thinking that has been through SQLite is still thinking the provider
 * accepts.
 *
 * `reasoning.ts` replays a block the session is still holding in memory.
 * `resume.ts` carries a conversation through the store, but a plain one, with
 * nothing sealed in it. Neither covers the pair: a seal written to a column,
 * read back by another run, and handed to the provider that issued it.
 *
 * That pair is where a defect would hide. The seal is text in a nullable
 * column, and it is the one value in the store that another party validates.
 * A store that truncated it, reordered the parts around it, or dropped it for
 * one shape would pass every unit test here, and fail only on the first
 * question somebody asks after reopening a session.
 *
 * Each shape is run on its own, because each seals differently, and each is
 * asked its second question in a second run against the same database.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { continueSession, type ResumeContext } from '../src/core/resume.js';
import { openSession } from '../src/core/run.js';
import type { Turn, TurnPart } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/handle.js';
import { layerNodeStore } from '../src/plugins/store/node.js';
import { kilo } from './setup.js';

/* Named here and not taken from the environment, as in `reasoning.ts`. What is
   under test is the seal, so a model that seals nothing would report the run's
   own subject missing and call it a defect. The model is part of the fixture. */
const model = 'anthropic/claude-sonnet-4.5';

const system = 'You answer briefly. Think first, then give the answer in one short sentence.';
const first = 'A farmer has 17 sheep. All but 9 run away. How many are left? Explain in one line.';
const second = 'Now double that number and tell me the result.';

/** The shapes, and whether each hands back something that can be replayed. */
const shapes: readonly { readonly kind: ApiKind; readonly seals: boolean }[] = [
  { kind: 'messages', seals: true },
  { kind: 'responses', seals: true },
  /* Nothing to replay, so what is under test here is that a stored block with
     no seal does not break the request it is loaded into. */
  { kind: 'chat_completions', seals: false },
];

interface Answer {
  readonly said: string;
  readonly thought: string;
}

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text, { maxTokens: 4000 }), { said: '', thought: '' }, (held, event) =>
    event.kind === 'delta'
      ? { ...held, said: held.said + event.text }
      : event.kind === 'reasoning'
        ? { ...held, thought: held.thought + event.text }
        : held
  );

/**
 * What went wrong, in one line. A `ModelError` whose cause is an `Error`
 * stringifies to `{}`, which tells a reader nothing about the run that failed.
 */
const why = (error: object): string => {
  const cause = 'cause' in error ? error.cause : undefined;
  return cause instanceof Error ? cause.message : JSON.stringify(error).slice(0, 300);
};

const reasoningIn = (turns: readonly Turn[]): readonly TurnPart[] =>
  turns.flatMap(turn => turn.parts.filter(part => part.kind === 'reasoning'));

/** The seal as the store holds it, or nothing when the shape issues none. */
const sealOf = (parts: readonly TurnPart[]): string | undefined =>
  parts[0]?.kind === 'reasoning' ? parts[0].signature : undefined;

/**
 * One shape, two runs, one database. The layers are built again for the second
 * run, which is what a second start of an application does.
 */
const through = async (kind: ApiKind) => {
  const database = new DatabaseSync(':memory:');
  const layers = Layer.mergeAll(kilo({ apiKinds: [kind] }), layerNodeStore(database));
  const run = <A, E>(use: Effect.Effect<A, E, ResumeContext>): Promise<A> =>
    Effect.runPromise(Effect.scoped(Effect.provide(use, layers)));

  const opened = await run(
    Effect.gen(function* () {
      const session = yield* openSession({ system, model, effort: 'medium' });
      const answer: Answer = yield* ask(session, first);
      return { id: session.id, answer, parts: reasoningIn(yield* session.history) };
    })
  );

  const reopened = await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const session = yield* continueSession(opened.id);
            const loaded = reasoningIn(yield* session.history);
            const answer: Answer = yield* ask(session, second);
            return { loaded, answer };
          }),
          layers
        )
      )
    )
  );

  return { opened, reopened };
};

console.log('shape             seal written  seal read  answered');

const failures: string[] = [];

for (const { kind, seals } of shapes) {
  const { opened, reopened } = await through(kind);
  const written = sealOf(opened.parts);

  if (reopened._tag === 'Left') {
    console.log(`${kind.padEnd(18)}${String(written?.length ?? 'none').padEnd(14)}FAILED`);
    /* The whole point of the run. A seal the provider will not take back is a
       session that cannot be continued at all. */
    failures.push(`${kind}: the reopened session was refused: ${why(reopened.left)}`);
    continue;
  }

  const read = sealOf(reopened.right.loaded);
  console.log(
    `${kind.padEnd(18)}${String(written?.length ?? 'none').padEnd(14)}` +
      `${String(read?.length ?? 'none').padEnd(11)}` +
      JSON.stringify(reopened.right.answer.said.slice(0, 28))
  );

  if (seals && written === undefined) {
    failures.push(`${kind}: nothing was sealed, so this shape proves nothing`);
  }
  if (read !== written) {
    failures.push(`${kind}: the seal read back is not the seal that was written`);
  }
  if (seals && reopened.right.loaded.length !== opened.parts.length) {
    failures.push(
      `${kind}: the store gave back ${String(reopened.right.loaded.length)} reasoning parts ` +
        `where ${String(opened.parts.length)} were written`
    );
  }
  if (reopened.right.answer.said.length === 0) {
    failures.push(`${kind}: the reopened session answered with nothing`);
  }
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log('\nPASS: every shape took back thinking that had been through the store.');
