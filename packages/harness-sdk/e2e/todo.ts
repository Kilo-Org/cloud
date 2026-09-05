/**
 * Proves the todo tool against a real model, over three turns of one session.
 *
 * `todo.test.ts` proves the tool holds a list and reads it back. What only a
 * provider can settle is the shape of the payload and what a model does with
 * it across a conversation:
 *
 * - **The schema renders on every shape.** An array of objects with an
 *   enumerated field is the richest parameter schema this package ships, and
 *   the three shapes write it three different ways.
 * - **The whole list comes every time.** The tool replaces rather than patches,
 *   and the description says so. A model that sent only the step it had changed
 *   would leave a list of one, which is the failure this run is for.
 * - **The list survives the conversation.** Three turns, and the third asks
 *   only for what the list now says, so an answer can only come from what the
 *   tool read back.
 *
 * The plan is dictated rather than invented, so what is measured is the tool
 * and not the model's taste in project management. The marks are printed and
 * not asserted, for the same reason: whether a model moves a step to `doing`
 * or straight to `done` is the model's discipline, and
 * `pnpm test:e2e:tool-matrix` is the run that scores what models choose.
 */
import { Effect, Layer } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { said } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import { ToolRegistry } from '../src/core/tool.js';
import { type Todo, todoTool } from '../src/plugins/tools/todo.js';
import { kilo, models } from './setup.js';
import { fail, passed, under } from './report.js';

const system =
  'You are a test harness with tools. Keep the plan in the todo tool: write ' +
  'the steps down when you are given them, and send the whole list every time ' +
  'you change anything about it. Answer in one short sentence.';

const steps = ['cut the branch', 'run the checks', 'publish the notes'];

const opening =
  `Write my plan down with the todo tool, as these three steps in this order: ${steps.join(', ')}. ` +
  'Mark the first one as the one you are on. Then tell me what you wrote.';

const finished = 'I have cut the branch. Mark that step done and start the next one.';

const asked = 'Which step are you on? Answer with that step and nothing else.';

/** Every version of the list the harness was shown, in order. */
const versions: (readonly Todo[])[] = [];

const withTools = (kind: ApiKind) =>
  Layer.merge(
    kilo({ apiKinds: [kind] }),
    Layer.succeed(ToolRegistry, {
      tools: [
        todoTool({
          onChanged: todos => Effect.sync(() => void versions.push(todos)),
        }),
      ],
    })
  );

const marks = (todos: readonly Todo[]): string =>
  todos.map(todo => `${todo.state[0] ?? '?'}`).join('');

const runShape = async (model: string, kind: ApiKind): Promise<void> => {
  versions.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 512, tools: ['todo'] });
    yield* said(session.ask(opening));
    yield* said(session.ask(finished));
    return yield* said(session.ask(asked));
  });
  const answer = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withTools(kind))))
  );

  if (answer._tag === 'Left') {
    console.log(`${kind.padEnd(18)}FAILED  ${JSON.stringify(answer.left)}`);
    fail(`${kind}: the round failed, so the shape would not carry the list`);
    return;
  }

  const last = versions.at(-1) ?? [];
  console.log(
    `${kind.padEnd(18)}${String(versions.length).padEnd(8)}${String(last.length).padEnd(7)}` +
      `${marks(last).padEnd(8)}${JSON.stringify(answer.right.slice(0, 60))}`
  );

  if (versions.length < 2) {
    fail(`${kind}: the list was written ${String(versions.length)} times, so it was never updated`);
  }
  if (versions.some(version => version.length !== steps.length)) {
    const sizes = versions.map(version => version.length).join(', ');
    fail(`${kind}: the list held ${sizes} steps, not ${String(steps.length)} every time`);
  }
  /* Matched on the noun of each step, because a model rewrites "run the
     checks" as "Run checks" and the run is not about its prose. */
  const nounOf = (step: string): string => step.split(' ').at(-1) ?? step;
  if (!steps.every(step => last.some(todo => todo.text.toLowerCase().includes(nounOf(step))))) {
    fail(`${kind}: the list lost a step: ${JSON.stringify(last.map(todo => todo.text))}`);
  }
  if (!last.some(todo => todo.state === 'done')) {
    fail(`${kind}: nothing was marked done, though a step was finished`);
  }
  if (!answer.right.toLowerCase().includes('checks')) {
    fail(`${kind}: the model was asked what it is on and answered ${JSON.stringify(answer.right)}`);
  }
};

for (const model of models) {
  under(model);
  console.log(`\nmodel ${model}`);
  console.log('\nshape             writes  steps  states  answered');

  for (const kind of ['messages', 'responses', 'chat_completions'] as const) {
    await runShape(model, kind);
  }
}

under('');
passed(
  'every shape carried the list, and every model kept the whole plan in it across three turns'
);
