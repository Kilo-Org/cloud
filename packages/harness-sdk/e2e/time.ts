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
 * - **A model asks rather than guessing.** Every model here was trained before
 *   today and will happily invent a date. The tool exists because the guess is
 *   confidently wrong, so what is measured is whether the model calls it and
 *   whether today's date comes back in the answer.
 *
 * The date is checked against this machine's clock at the moment of the check,
 * so it cannot be pinned to a fixture and cannot rot.
 */
import { Effect, Layer } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { said } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import { type Tool, type ToolCall, ToolRegistry } from '../src/core/tool.js';
import { timeTool } from '../src/plugins/tools/time.js';
import { kilo, models } from './setup.js';
import { fail, passed, under } from './report.js';

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

const runShape = async (model: string, kind: ApiKind): Promise<void> => {
  ran.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 512, tools: ['time'] });
    return yield* said(session.ask('What is the date and time right now?'));
  });
  const answer = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withTools(kind))))
  );

  if (answer._tag === 'Left') {
    console.log(`${kind.padEnd(18)}FAILED    ${JSON.stringify(answer.left)}`);
    fail(`${kind}: the round failed, so the shape would not carry a tool that takes nothing`);
    return;
  }

  const spoken = answer.right.replaceAll(/\s+/gu, ' ').trim();
  console.log(
    `${kind.padEnd(18)}${String(ran.length).padEnd(7)}${JSON.stringify(spoken.slice(0, 90))}`
  );

  if (ran.length !== 1) {
    fail(`${kind}: the tool ran ${String(ran.length)} times, not once`);
  }
  const year = String(new Date().getUTCFullYear());
  if (!spoken.includes(year)) {
    fail(`${kind}: the answer does not carry this year, so the model answered from memory`);
  }
  if (!daysNow().some(day => spoken.includes(day))) {
    fail(`${kind}: the answer carries neither today's date in UTC nor the one in ${zone}`);
  }
};

for (const model of models) {
  under(model);
  console.log(`\nmodel ${model}`);
  console.log('\nshape             calls  answered');

  for (const kind of ['messages', 'responses', 'chat_completions'] as const) {
    await runShape(model, kind);
  }
}

under('');
passed('every shape carried a tool that takes nothing, and every model asked it what day it is');
