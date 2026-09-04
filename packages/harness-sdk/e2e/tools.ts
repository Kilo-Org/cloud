/**
 * Proves tools against the provider, which is the only party that can say the
 * package renders them right.
 *
 * A tool call is the one thing in this package that three shapes disagree
 * about: `messages` writes blocks, `responses` writes items beside the message,
 * `chat_completions` writes a field on the assistant message and a role of its
 * own for the result. A fake `fetch` proves the package writes what it meant
 * to. Only a real gateway proves the provider reads it — and a shape that
 * refuses a round refuses the whole session, because a call whose result it
 * will not read can never be answered.
 *
 * Three things run here:
 *
 * - **Every shape carries a round.** The model calls the tool, reads what it
 *   said, and answers with a word it could not have invented.
 * - **The calls of one turn overlap.** Two cities, two calls, and the second
 *   starts before the first has finished.
 * - **A call outlives the request.** The question tool takes longer than the
 *   deadline, the model is told so and carries on, and the session runs a round
 *   of its own when the answer lands.
 * - **The model decides for itself.** A tool that named no deadline is walked
 *   away from because the model set `wait: false` on the call, and what it says
 *   still comes back.
 */
import assert from 'node:assert/strict';
import { Duration, Effect, Layer, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { SessionHandle } from '../src/core/handle.js';
import { openSession } from '../src/core/run.js';
import { type Tool, ToolRegistry } from '../src/core/tool.js';
import { type Asker, questionTool } from '../src/plugins/tools/question.js';
import { kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

const system =
  'You are a test harness with tools. Call a tool whenever one answers the ' +
  'question. When you have what a tool said, answer the user in one short ' +
  "sentence that repeats the tool's words exactly. Never guess a value a tool " +
  'can give you.';

/** A word no model invents, so an answer carrying it came from the tool. */
const codes: Readonly<Record<string, string>> = { Oslo: 'kestrel', Lisbon: 'marmoset' };

const ran: { readonly city: string; readonly at: number; readonly done: number }[] = [];

/** What the tool was asked for, whatever the model wrapped it in. */
const cityIn = (args: string): string => {
  const found = Object.keys(codes).find(city => args.includes(city));
  return found ?? 'Oslo';
};

const weather = (takes: Duration.DurationInput): Tool => ({
  definition: {
    name: 'weather',
    description: 'The weather in one city. Call it once per city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'The city to report on.' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  run: call =>
    Effect.gen(function* () {
      const city = cityIn(call.arguments);
      const at = Date.now();
      yield* Effect.sleep(takes);
      ran.push({ city, at, done: Date.now() });
      return `The weather in ${city} is ${codes[city] ?? 'kestrel'}.`;
    }),
});

const answering = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text), '', (held: string, event) =>
    event.kind === 'delta' ? held + event.text : held
  );

const withTools = (kind: ApiKind, tools: readonly Tool[]) =>
  Layer.merge(kilo({ apiKinds: [kind] }), Layer.succeed(ToolRegistry, { tools }));

const failures: string[] = [];

/** One round on one shape: the model calls, reads, and answers with the word. */
const runShape = async (kind: ApiKind): Promise<void> => {
  ran.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 256, tools: ['weather'] });
    return yield* answering(session, 'What is the weather in Oslo?');
  });
  const said = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withTools(kind, [weather(0)]))))
  );

  if (said._tag === 'Left') {
    console.log(`${kind.padEnd(18)}FAILED    ${JSON.stringify(said.left)}`);
    failures.push(`${kind}: the round failed`);
    return;
  }
  console.log(`${kind.padEnd(18)}${String(ran.length).padEnd(10)}${JSON.stringify(said.right)}`);
  if (ran.length !== 1) {
    failures.push(`${kind}: the tool ran ${String(ran.length)} times, not once`);
  }
  if (!said.right.includes('kestrel')) {
    failures.push(`${kind}: the answer did not carry what the tool said`);
  }
};

/** Two calls in one turn have to overlap, or a slow tool costs the wall clock. */
const runTogether = async (): Promise<void> => {
  ran.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 256, tools: ['weather'] });
    return yield* answering(session, 'What is the weather in Oslo and in Lisbon?');
  });
  await Effect.runPromise(
    Effect.scoped(Effect.provide(program, withTools('messages', [weather('600 millis')])))
  );

  const [first, second] = [...ran].sort((one, other) => one.at - other.at);
  if (first === undefined || second === undefined) {
    failures.push(`two cities produced ${String(ran.length)} calls, not two`);
    return;
  }
  const overlap = first.done - second.at;
  console.log(`\ntwo calls in one turn overlapped by ${String(overlap)}ms`);
  if (overlap <= 0) {
    failures.push('the calls of one turn ran one after the other');
  }
};

/**
 * The question tool, answered slower than the model waits.
 *
 * This is the shape of every real question: nobody answers in the moment they
 * are asked. The model must be told the question is out, answer without it, and
 * then be asked again on its own when the answer lands.
 */
const runBackgrounded = async (): Promise<void> => {
  const asker: Asker = questions =>
    Effect.as(
      Effect.sleep('3 seconds'),
      questions.map(question => ({ id: question.id, text: 'ultramarine' }))
    );
  const tool = questionTool(asker, { inlineFor: Duration.millis(500) });

  const program = Effect.gen(function* () {
    const session = yield* openSession({
      /* The claim here is the harness's deadline, so the model's veto over it is
         taken away. A model that sets `wait` is honoured, which is what
         `runWanted` is for. */
      system: `${system} Never set wait on a tool call.`,
      model,
      maxTokens: 256,
      tools: ['question'],
    });
    /* Watch first: the round the session starts on its own happens whether or
       not anybody is listening, and a late subscriber hears none of it. */
    const watching = yield* Effect.fork(
      Effect.timeout(
        Stream.runFold(
          /* One round and no more. The stream itself never ends: it carries
             every round the session ever starts on its own. */
          Stream.takeUntil(session.continued, one => 'failed' in one || one.event.kind === 'done'),
          '',
          (held: string, one) =>
            !('failed' in one) && one.event.kind === 'delta' ? held + one.event.text : held
        ),
        '60 seconds'
      )
    );
    const first = yield* answering(
      session,
      'Ask me for my favourite colour with the question tool, then tell me what I said.'
    );
    return { first, later: yield* watching.await };
  });

  const got = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withTools('messages', [tool]))))
  );

  if (got._tag === 'Left') {
    console.log(`\nbackgrounded      FAILED    ${JSON.stringify(got.left)}`);
    failures.push('the backgrounded round failed');
    return;
  }

  const { first, later } = got.right;
  const said = later._tag === 'Success' ? later.value : '';
  console.log(`\nasked, not waited: ${JSON.stringify(first)}`);
  console.log(`told later:        ${JSON.stringify(said)}`);

  if (first.includes('ultramarine')) {
    failures.push('the model was given the answer inline, so nothing was backgrounded');
  }
  if (!said.includes('ultramarine')) {
    failures.push('the session never told the model what the person answered');
  }
};

/**
 * The model choosing not to wait, on a tool that never asked to be backgrounded.
 *
 * This is the one claim a fake cannot make: that a real model reads the `wait`
 * field it is offered and answers it. The tool takes three seconds and names no
 * deadline of its own, so the session's thirty would hold the model there. Only
 * the model's own `wait: false` moves it on — and the answer still arrives, in
 * a round of its own, exactly as a deadline's would.
 */
const runWanted = async (): Promise<void> => {
  ran.length = 0;
  const program = Effect.gen(function* () {
    const session = yield* openSession({
      system: `${system} A tool call you set wait to false on runs without you. Set wait to false whenever a call would take a while and you can say something useful before it answers.`,
      model,
      maxTokens: 256,
      tools: ['weather'],
    });
    const watching = yield* Effect.fork(
      Effect.timeout(
        Stream.runFold(
          Stream.takeUntil(session.continued, one => 'failed' in one || one.event.kind === 'done'),
          '',
          (held: string, one) =>
            !('failed' in one) && one.event.kind === 'delta' ? held + one.event.text : held
        ),
        '60 seconds'
      )
    );
    const first = yield* answering(
      session,
      'What is the weather in Oslo? Do not wait for the tool — tell me you have asked, and I will hear the rest when it answers.'
    );
    return { first, later: yield* watching.await };
  });

  const got = await Effect.runPromise(
    Effect.either(
      Effect.scoped(Effect.provide(program, withTools('messages', [weather('3 seconds')])))
    )
  );

  if (got._tag === 'Left') {
    console.log(`\nwait: false       FAILED    ${JSON.stringify(got.left)}`);
    failures.push('the round the model chose not to wait for failed');
    return;
  }

  const { first, later } = got.right;
  const said = later._tag === 'Success' ? later.value : '';
  console.log(`\ndid not wait:      ${JSON.stringify(first)}`);
  console.log(`told later:        ${JSON.stringify(said)}`);

  if (first.includes('kestrel')) {
    failures.push('the model waited for the call, so it never set wait to false');
  }
  if (!said.includes('kestrel')) {
    failures.push('the call the model walked away from never came back');
  }
};

console.log('model', model);
console.log('\nshape             calls     answered');

for (const kind of ['messages', 'responses', 'chat_completions'] as const) {
  await runShape(kind);
}
await runTogether();
await runBackgrounded();
await runWanted();

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log(
  '\nPASS: every shape ran a tool, the calls overlapped, a late answer drove a round, and the model chose not to wait.'
);
