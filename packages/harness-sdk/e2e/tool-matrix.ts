/**
 * The tools this package ships, used by every model, not only by Haiku.
 *
 * A tool is one version for everybody. There is no per-model branch and there
 * will not be one: a harness cannot keep eleven descriptions honest, and a
 * model the package has never seen has to work anyway. So the way to tune a
 * description is to measure it across labs and change the one text until every
 * row is clean.
 *
 * What is scored is what the model chose, never what it said:
 *
 * - **called** — it used the tool instead of answering from nothing.
 * - **valid** — the arguments were what the schema asked for. A model that
 *   calls a tool and sends the wrong shape has read the description and not the
 *   schema, which is a schema to fix.
 * - **batched** — it asked everything in one call. The question tool says to,
 *   and a model that ignores it puts a person through two dialogs for one task.
 * - **waited** — whether the model sat on the call. This is read from what the
 *   harness told it rather than from what it sent: a call the model did not
 *   wait for gets the still-running note, and that note is in the event stream.
 *
 * There is no right answer to **waited**, which is why `Tool.wait` is a default
 * and not a rule. Both scenarios here block — a deployment nobody has answered
 * about, a codename the model does not know — so waiting is correct in both,
 * and the two tools ship opposite defaults. What the column measures is whether
 * the model reads the field at all: `question` defaults to waiting and the
 * model keeps it, `subagent` defaults to not and the model has to override it.
 * A model that never overrides is a model ignoring the field.
 *
 * The run fails on a floor — every model calls the tool, and sends a payload
 * the tool can read — and reports the rest as numbers. A model that batches
 * badly is a description to tune, not a broken package.
 */
import { Effect, Layer, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { ModelEvent } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import { type Tool, ToolRegistry } from '../src/core/tool.js';
import { type Asker, type Question, questionTool } from '../src/plugins/tools/question.js';
import { subagentTool } from '../src/plugins/tools/subagent.js';
import { kilo } from './setup.js';
import { failures, passed } from './report.js';

/** The ten of `e2e/models.ts`, and Haiku for the one lab that list leaves out. */
const models = [
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.6-luna',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-0731',
  'qwen/qwen3.8-flash',
  'xiaomi/mimo-v2.5',
  'tencent/hy3',
  'deepseek/deepseek-v4-flash',
  'minimax/minimax-m3',
  'nvidia/nemotron-3.5-lightning',
  'google/gemini-3.7-flash',
] as const;

const chosen = process.env['KILO_MODELS']?.split(',') ?? models;
const maxTokens = Number(process.env['KILO_MAX_TOKENS'] ?? '1024');

const system =
  'You are a coding harness with tools. Use a tool whenever one can answer ' +
  'better than you can, and never invent a value a tool can give you. Keep ' +
  'every answer to one or two short sentences.';

/** The words the harness gives the model for a call it is not waiting on. */
const notWaited = 'This call is still running';

/** What one model did with one tool. */
interface Scored {
  readonly called: boolean;
  readonly valid: boolean;
  readonly waited: boolean;
  /** How many questions were in the first call. Zero where there is nothing to batch. */
  readonly together: number;
  /** What the model answered. Printed under the table for a row that missed the floor. */
  readonly said: string;
}

const nothing: Scored = { called: false, valid: false, waited: false, together: 0, said: '' };

/** What the round says about the call, read out of the events themselves. */
const watched = (events: readonly ModelEvent[]) => ({
  called: events.some(event => event.kind === 'toolCall'),
  waited: events.some(
    event => event.kind === 'toolResult' && !event.result.body.startsWith(notWaited)
  ),
  said: events
    .filter(event => event.kind === 'delta')
    .map(event => event.text)
    .join('')
    .trim(),
});

const preferred: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];

/**
 * Tries the best shape first, then the one every provider serves.
 *
 * Same fallback as `e2e/models.ts`. A provider that refuses a shape is not a
 * model using a tool badly, and scoring it as one would put a row in the table
 * that no description can fix.
 */
const tried = async (
  build: (kinds: readonly ApiKind[]) => Effect.Effect<Scored, unknown, never>
): Promise<Scored> => {
  const got = await Effect.runPromise(
    Effect.either(build(preferred).pipe(Effect.catchAll(() => build(['chat_completions']))))
  );
  return got._tag === 'Left' ? nothing : got.right;
};

/* ---------------------------------------------------------------- question */

/**
 * A task that cannot be finished without asking, and that needs two answers.
 *
 * Two, because batching is only visible when there is something to batch, and
 * a model that asks one at a time puts a person through two dialogs for one
 * task.
 */
const asking =
  'Set up my deployment. I have not told you which region to deploy to, or ' +
  'whether to turn on backups. Find out from me, then say what you will do.';

const answerOf = (question: Question) => ({
  id: question.id,
  ...(question.choices === undefined
    ? { text: /backup/iu.test(question.prompt) ? 'yes' : 'frankfurt' }
    : { chosen: [question.choices[0]?.value ?? ''] }),
});

const oneQuestion = (model: string, kinds: readonly ApiKind[]) =>
  Effect.suspend(() => {
    const asked: (readonly Question[])[] = [];
    const ask: Asker = questions =>
      Effect.sync(() => {
        asked.push(questions);
        return questions.map(answerOf);
      });
    const layers = Layer.merge(
      kilo({ apiKinds: kinds }),
      Layer.succeed(ToolRegistry, { tools: [questionTool(ask)] })
    );
    const program = Effect.gen(function* () {
      const session = yield* openSession({ system, model, maxTokens, tools: ['question'] });
      return [...(yield* Stream.runCollect(session.ask(asking)))];
    });
    return Effect.map(Effect.scoped(Effect.provide(program, layers)), events => ({
      ...watched(events),
      /* The asker runs on arguments the schema accepted and on nothing else, so
         reaching it at all is the payload being right. */
      valid: asked.length > 0,
      together: asked[0]?.length ?? 0,
    }));
  });

/* ---------------------------------------------------------------- subagent */

const secret = 'quartzite';

const subSystem =
  'You are a lookup service for the Acme Deploy project. The codename of its ' +
  `4.0 release is "${secret}". Answer in one short sentence, and always give ` +
  'the codename when asked.';

/**
 * One fact the model cannot know, about a thing named exactly once.
 *
 * The first version asked for "this quarter's codename" and four models
 * answered by asking which project was meant, which is the right move on a
 * question that names none. That measured the prompt, not the tool: a model
 * that will not guess is doing its job. Naming the release leaves one reason
 * left not to delegate, which is the tool description, which is the thing under
 * test.
 */
const delegating = 'What is the codename of the Acme Deploy 4.0 release? Find out and tell me.';

/**
 * The task the model handed down, or nothing if it was not the shape asked for.
 *
 * The subagent's own answer is not what is scored here. The parent does not
 * wait for it by default, so a run that read the answer would be scoring the
 * clock; what the parent chose to send down is decided before any of that.
 */
const taskOf = (held: string): string | undefined => {
  const sent: unknown = JSON.parse(held);
  const task =
    typeof sent === 'object' && sent !== null ? (sent as { task?: unknown }).task : undefined;
  return typeof task === 'string' && task.trim() !== '' ? task : undefined;
};

/** The shipped tool, with what the model sent it kept on the way past. */
const noting = (tool: Tool, sent: string[]): Tool => ({
  ...tool,
  run: call => {
    sent.push(call.arguments);
    return tool.run(call);
  },
});

const oneSubagent = (model: string, kinds: readonly ApiKind[]) =>
  Effect.suspend(() => {
    const sent: string[] = [];
    const under = kilo({ apiKinds: kinds });
    const tool = noting(subagentTool({ system: subSystem, model, maxTokens: 128 }, under), sent);
    const layers = Layer.merge(under, Layer.succeed(ToolRegistry, { tools: [tool] }));
    const program = Effect.gen(function* () {
      const session = yield* openSession({ system, model, maxTokens, tools: ['subagent'] });
      return [...(yield* Stream.runCollect(session.ask(delegating)))];
    });
    return Effect.map(Effect.scoped(Effect.provide(program, layers)), events => ({
      ...watched(events),
      valid: sent.some(one => taskOf(one) !== undefined),
      together: 0,
    }));
  });

/* ------------------------------------------------------------------- table */

const scored = async (model: string) => ({
  model,
  question: await tried(kinds => oneQuestion(model, kinds)),
  subagent: await tried(kinds => oneSubagent(model, kinds)),
});

const rows = await Promise.all(chosen.map(scored));

const pad = (text: string, width: number) => text.padEnd(width);
const mark = (right: boolean) => (right ? 'yes' : 'NO');

console.log(
  `\n${pad('model', 32)}${pad('question', 32)}subagent\n` +
    `${pad('', 32)}${pad('called valid batch  waited', 32)}called valid waited`
);

for (const { model, question, subagent } of rows) {
  console.log(
    pad(model, 32) +
      pad(mark(question.called), 7) +
      pad(mark(question.valid), 6) +
      pad(question.together > 1 ? 'yes' : String(question.together), 7) +
      pad(mark(question.waited), 12) +
      pad(mark(subagent.called), 7) +
      pad(mark(subagent.valid), 6) +
      mark(subagent.waited)
  );

  /* The floor. Everything else is a number to tune a description against. */
  for (const [name, one] of [
    ['question', question],
    ['subagent', subagent],
  ] as const) {
    if (!one.called) {
      failures.push(`${model} never called ${name}, and said: ${JSON.stringify(one.said)}`);
    } else if (!one.valid) {
      failures.push(`${model} sent ${name} a payload it could not read`);
    }
  }
}

const share = (of: (row: (typeof rows)[number]) => boolean) =>
  `${String(rows.filter(of).length)} of ${String(rows.length)}`;

console.log(
  `\nasked everything in one call:      ${share(row => row.question.together > 1)}` +
    `\nkept question's waiting default:   ${share(row => row.question.waited)}` +
    `\noverrode subagent's, as it had to: ${share(row => row.subagent.called && row.subagent.waited)}`
);

passed('every model called both tools and sent each one a payload it could read.');
