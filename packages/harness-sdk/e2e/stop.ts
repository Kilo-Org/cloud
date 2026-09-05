/**
 * Proves each shape reports why the model stopped.
 *
 * A unit test can only prove this package reads the field it was given. Which
 * field a gateway actually sends, and what it puts in it, is a live question,
 * and the three shapes answer it three different ways.
 *
 * Each shape is asked twice: once with room to finish, and once with a ceiling
 * far too low to. The second must come back `maxTokens`. A shape that reported
 * `end` for both would let a caller store half a sentence as a finished answer
 * and build every later request on it.
 */
import { Effect, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { StopReason } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import { kilo, models } from './setup.js';
import { fail, passed, under } from './report.js';

const system = 'You answer exactly what you are asked, with no preamble.';
const short = 'Answer with the single word: yes';
const long = 'Write three hundred words about the history of the wheel.';

interface Answer {
  readonly said: string;
  readonly stop: StopReason | undefined;
}

const empty: Answer = { said: '', stop: undefined };

const ask = (session: SessionHandle, text: string, maxTokens: number) =>
  Stream.runFold(session.ask(text, { maxTokens }), empty, (held, event) => {
    if (event.kind === 'delta') {
      return { ...held, said: held.said + event.text };
    }
    return event.kind === 'done' ? { ...held, stop: event.stop } : held;
  });

const runShape = async (model: string, kind: ApiKind) => {
  const layers = kilo({ apiKinds: [kind] });

  /* Two sessions, because a truncated answer left in the first one would
     change what the second question is answering. */
  const program = Effect.gen(function* () {
    /* 256 to say one word, because the ceiling is this run's other subject and
       must not be hit here by accident: a model that thinks spends anything
       less before it answers, and reports the wall it was meant to clear. */
    const finished = yield* Effect.flatMap(openSession({ system, model }), session =>
      ask(session, short, 256)
    );
    const cut = yield* Effect.flatMap(openSession({ system, model }), session =>
      ask(session, long, 24)
    );
    return { finished, cut };
  });

  return Effect.runPromise(Effect.either(Effect.scoped(Effect.provide(program, layers))));
};

const kinds: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];

for (const model of models) {
  under(model);

  console.log('model', model);
  console.log('\nshape             finished  cut off   said when cut');

  for (const kind of kinds) {
    const result = await runShape(model, kind);
    if (result._tag === 'Left') {
      console.log(`${kind.padEnd(18)}FAILED    ${JSON.stringify(result.left)}`);
      fail(`${kind}: the call failed`);
      continue;
    }

    const { finished, cut } = result.right;
    console.log(
      `${kind.padEnd(18)}${String(finished.stop).padEnd(10)}${String(cut.stop).padEnd(10)}` +
        JSON.stringify(cut.said.slice(0, 30))
    );

    if (finished.stop !== 'end') {
      fail(`${kind}: an answer that finished was reported as ${String(finished.stop)}, not end`);
    }
    if (cut.stop !== 'maxTokens') {
      fail(
        `${kind}: an answer cut off at the ceiling was reported as ${String(cut.stop)}; a caller ` +
          'would store half a sentence as a finished answer'
      );
    }
  }
}

passed('every shape tells a finished answer from one the ceiling cut off.');
