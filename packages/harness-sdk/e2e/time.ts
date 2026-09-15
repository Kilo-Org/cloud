/**
 * Proves the time tool against a real model, on all three shapes.
 *
 * `time.test.ts` proves the words the tool writes. It cannot prove the two
 * things that are only true against a provider:
 *
 * - **A tool that takes nothing renders on every shape.** Its parameters are an
 *   object with no properties, which is the one schema a provider is most
 *   likely to refuse: three shapes write it three ways, and a shape that
 *   rejected it would refuse the whole round rather than one call.
 * - **What the tool wrote comes back.** A model that called it and then
 *   answered with a different date has been handed the answer and ignored it,
 *   and that is the package's failure to fix.
 *
 * The date is checked against this machine's clock at the moment of the check,
 * so it cannot be pinned to a fixture and cannot rot.
 *
 * **Whether the model calls it is counted, not asserted.** Measured on
 * 2026-09-05, `minimax/minimax-m3` answers "I don't have access to a time tool"
 * about one round in eight, with the tool plainly in the request: hand-written
 * requests carrying no part of this package do the same, a stronger description
 * does not move it, and `tool_choice: "required"` is not honoured for it. So a
 * miss is one model's free choice on one round, and a suite that failed on it
 * would go red on a different model every run for something no change here can
 * fix. What is asserted is the floor underneath: the shape carries the tool,
 * and a model that called it answers with what it was given. A model that calls
 * it on none of the three shapes is the description failing, and that does fail
 * the run.
 *
 * The same line is drawn in `e2e/tool-matrix.ts`, for the same reason.
 */
import { Effect, Layer } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { said } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import { type Tool, type ToolCall, ToolRegistry } from '../src/core/tool.js';
import { timeTool } from '../src/plugins/tools/time.js';
import { kilo, models, room } from './setup.js';
import { fail, passed, under, wrongIf } from './report.js';

const system =
  'You are a test harness with tools. You do not know what day it is and you ' +
  'must never guess: use the time tool. Answer in one short sentence that ' +
  'repeats the date and time the tool gave you.';

const zone = 'Australia/Sydney';

/** What the model sent, so the run can say whether it called at all. */
const ran: ToolCall[] = [];

const watched = (): Tool => {
  const tool = timeTool({ zone });
  return {
    ...tool,
    run: (call: ToolCall) => {
      ran.push(call);
      return tool.run(call);
    },
  };
};

const withTools = (kind: ApiKind) =>
  Layer.merge(kilo({ apiKinds: [kind] }), Layer.succeed(ToolRegistry, { tools: [watched()] }));

/** The day, in whichever of the two places the model chose to answer from. */
const daysNow = (): readonly string[] => {
  const now = new Date();
  const there = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const of = (type: string): string => there.find(part => part.type === type)?.value ?? '';
  return [String(now.getUTCDate()), of('day').replace(/^0/u, '')];
};

/** One round, or the reason it never happened. */
const asked = async (model: string, kind: ApiKind): Promise<string | undefined> => {
  ran.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: room, tools: ['time'] });
    return yield* said(session.ask('What is the date and time right now?'));
  });
  const answer = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withTools(kind))))
  );
  return answer._tag === 'Left' ? undefined : answer.right;
};

/**
 * Whether the model called the tool on this shape.
 *
 * A round that failed is tried once more before it counts: measured on
 * 2026-09-05, `xiaomi/mimo-v2.5` refused two shapes on one sweep and carried
 * all three on the next, which is the relay having a bad minute rather than a
 * shape that cannot write a tool taking nothing. Twice is a finding.
 */
const runShape = async (model: string, kind: ApiKind): Promise<boolean> => {
  const answer = (await asked(model, kind)) ?? (await asked(model, kind));
  if (answer === undefined) {
    console.log(`${kind.padEnd(18)}FAILED    the round failed twice`);
    fail(`${kind}: the round failed twice, so the shape would not carry a tool that takes nothing`);
    return false;
  }

  const spoken = answer.replaceAll(/\s+/gu, ' ').trim();
  console.log(
    `${kind.padEnd(18)}${String(ran.length).padEnd(7)}${JSON.stringify(spoken.slice(0, 90))}`
  );
  wrongIf(ran.length > 1, `${kind}: the tool ran ${String(ran.length)} times for one question`);
  if (ran.length === 0) {
    return false;
  }

  /* From here the tool ran, so the date is the package's to get right: what it
     wrote went to the model, and what the model says is what it was given. */
  const year = String(new Date().getUTCFullYear());
  wrongIf(
    !spoken.includes(year),
    `${kind}: the tool ran and the answer carries a different year, so what it wrote never landed`
  );
  wrongIf(
    !daysNow().some(day => spoken.includes(day)),
    `${kind}: the tool ran and the answer carries neither today's date in UTC nor the one in ${zone}`
  );
  return true;
};

/** Which models chose not to call, and on which shapes. Printed at the end. */
const missed: string[] = [];

for (const model of models) {
  under(model);
  console.log(`\nmodel ${model}`);
  console.log('\nshape             calls  answered');

  const shapes = ['messages', 'responses', 'chat_completions'] as const;
  const called: ApiKind[] = [];
  for (const kind of shapes) {
    if (await runShape(model, kind)) {
      called.push(kind);
    }
  }
  if (called.length < shapes.length) {
    missed.push(
      `${model}: called on ${called.length === 0 ? 'no shape' : called.join(', ')} of ${String(shapes.length)}`
    );
  }
  wrongIf(
    called.length === 0,
    'the model called the tool on none of the three shapes, which is the description failing rather than one bad round'
  );
}

under('');
if (missed.length > 0) {
  console.log(`\nchose not to call:\n  ${missed.join('\n  ')}`);
}
passed('every shape carried a tool that takes nothing, and what it wrote came back in the answer');
