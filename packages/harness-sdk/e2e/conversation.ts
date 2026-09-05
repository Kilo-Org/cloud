/**
 * One conversation, end to end, of the shape a harness actually has.
 *
 * Every other live run proves one thing on its own: the cache, the line, a
 * tool, the store. A harness does all of it at once, in one session, and the
 * defects that only show up there are the ones nobody has a test for — a tool
 * that works alone and not beside another, a queued message that arrives while
 * a subagent is out, a summary that drops the one fact the next turn needs.
 *
 * So this is a person and an agent working through a small migration together:
 *
 * - **It asks the time.** The time tool, which takes no arguments.
 * - **It writes the plan down.** The todo tool, several steps, marked as they go.
 * - **It asks the person two things in one call.** The question tool, with
 *   choices, answered slower than the model waits, so the answer lands in a
 *   round of its own.
 * - **The person types while it is busy.** A queued message, answered in the
 *   order it joined.
 * - **It sends a subagent to look something up.** A session of its own, whose
 *   answer carries a word the parent could not know, and whose counts come back
 *   to the caller.
 * - **It is reopened from SQLite**, and remembers.
 * - **It is cloned**, and the copy reads its prefix from the cache.
 * - **It is compacted**, and still remembers.
 *
 * What is asserted is correctness first — every claim above, per model — and
 * then performance: the median time to the first word, the median whole
 * answer, the share of the prompt read from cache, and the wall clock for the
 * conversation. The ceilings are generous on purpose. They are there to catch a
 * change that makes the package slow, not to rank the providers: a run that
 * failed because a provider had a bad minute would teach nobody anything.
 *
 * `pnpm test:e2e:conversation` works through one model.
 * `pnpm test:e2e:conversation full` works through all eleven.
 */
import { DatabaseSync } from 'node:sqlite';
import { Duration, Effect, Fiber, Layer, Ref, Schedule, Stream } from 'effect';
import { SessionBusyError } from '../src/core/ask.js';
import type { ModelUsage } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import { cloneSession, continueSession } from '../src/core/resume.js';
import type { SessionHandle } from '../src/core/handle.js';
import type { Continued } from '../src/core/queue.js';
import type { Turn } from '../src/core/turn.js';
import { type Tool, ToolRegistry } from '../src/core/tool.js';
import { hitRatio } from '../src/core/usage.js';
import { type Answer, type Asker, type Question, questionTool } from '../src/plugins/tools/question.js';
import { type SubagentReport, subagentTool } from '../src/plugins/tools/subagent.js';
import { timeTool } from '../src/plugins/tools/time.js';
import { type Todo, todoTool } from '../src/plugins/tools/todo.js';
import { layerNodeStore } from '../src/plugins/store/node.js';
import { kilo, models } from './setup.js';
import { passed, under, wrongIf } from './report.js';

/**
 * One convention of the project, of which there are two hundred.
 *
 * The length is the point. A harness carries a long brief, and the whole claim
 * of the prompt cache is that it is paid for once; a short prompt caches
 * nothing at all on any provider here, and a conversation measured against it
 * would read as a failure of the package rather than of the prompt it was
 * given.
 */
const convention = (index: number) =>
  `Convention ${String(index)}: keep the change small, name the file you touched, ` +
  'and say what you did in one line. Do not rewrite what you were not asked to ' +
  'rewrite. Do not add a dependency where the standard library answers. Run the ' +
  'checks before you say a thing is done.';

const system = [
  'You are the assistant one person works with on their release. You have ' +
    'tools: use the one the person names, and use it rather than answering ' +
    'from memory. You have no files and no shell, and nothing here needs ' +
    'either: everything you are asked for is in this conversation or comes ' +
    'from a tool. Answer in one or two short sentences, and never ask for ' +
    'anything you were not asked to ask for. The project conventions follow, ' +
    'and they all hold.',
  ...Array.from({ length: 200 }, (_, index) => convention(index)),
].join('\n');

/** A word no model can invent, so an answer carrying it came from the subagent. */
const codename = 'nightjar';

/** A fact planted early and asked for at the very end, after the summary. */
const secret = 'the staging database is called quokka';

const subSystem =
  'You answer in one short sentence, from these facts and nothing else. The ' +
  `codename of the Acme Deploy 4.0 release is ${codename}. The release is out ` +
  'on the fourth of March. Nobody else knows either.';

/** What one turn cost the person, in the way a person feels it. */
interface Timing {
  /** Milliseconds from asking to the first word of the answer. */
  readonly first: number;
  /** Milliseconds from asking to the end of the answer. */
  readonly whole: number;
}

/**
 * Asks, keeps the words, and times the answer as the person sees it.
 *
 * A session busy with a round of its own refuses rather than corrupting the
 * prefix, so the person waits and asks again. That is the harness's job and not
 * the package's: the refusal is the package doing the right thing, and this is
 * what a caller does with it.
 */
const timed = (session: SessionHandle, input: string, timings: Timing[]) =>
  Effect.retry(asking(session, input, timings), {
    while: (cause: unknown) => cause instanceof SessionBusyError,
    schedule: Schedule.spaced('500 millis').pipe(Schedule.upTo('90 seconds')),
  });

const asking = (session: SessionHandle, input: string, timings: Timing[]) =>
  Effect.suspend(() => {
    const started = Date.now();
    let first = 0;
    return Stream.runFold(session.ask(input), '', (held, event) => {
      if (event.kind !== 'delta') {
        return held;
      }
      first = first === 0 ? Date.now() - started : first;
      return held + event.text;
    }).pipe(
      Effect.tap(() => Effect.sync(() => void timings.push({ first, whole: Date.now() - started })))
    );
  });

/**
 * Watches the rounds the session runs on its own, per session.
 *
 * `e2e/rounds.ts` keeps its refusals in one array for the module, which is
 * right for a run that works through one session at a time. This one runs
 * several models at once, so each conversation counts its own.
 *
 * The deadline is on the waiting and never around the reading — see the note in
 * `e2e/rounds.ts`, which is where that was measured.
 */
const watching = (session: SessionHandle, within: Duration.DurationInput) =>
  Effect.gen(function* () {
    const rounds: { answering: readonly string[]; text: string }[] = [];
    const refused: string[] = [];
    const held = { answering: [] as readonly string[], text: '' };
    const over = (one: Continued): boolean => {
      const event = 'failed' in one ? undefined : one.event;
      return event?.kind === 'done' && event.stop !== 'tools';
    };
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(
        session.continued,
        (one: Continued) =>
          Effect.sync(() => {
            held.answering = one.answering;
            const event = 'failed' in one ? undefined : one.event;
            if (event?.kind === 'delta') {
              held.text += event.text;
            }
            if ('failed' in one) {
              refused.push(String(one.failed));
            }
            if (over(one) || 'failed' in one) {
              rounds.push({ answering: held.answering, text: held.text });
              held.text = '';
            }
          })
      )
    );
    return {
      rounds,
      refused,
      /* Waits for the session to go quiet, not for a number of rounds. How
         many rounds a conversation runs is the model's to decide: one that
         waits for its subagent answers inline and runs none, and counting them
         would hold every other model at the deadline for nothing. */
      done: Effect.retry(
        Effect.filterOrFail(
          Effect.zip(session.queued, session.running),
          ([waiting, running]) => waiting.length === 0 && running.length === 0,
          () => 'still working' as const
        ),
        Schedule.spaced('500 millis').pipe(Schedule.upTo(within))
      ).pipe(
        Effect.ignore,
        /* One more beat, because the last round's words arrive just after the
           line empties: the entry leaves the line when the round starts, not
           when it ends. Five seconds is longer than any round here takes to
           write its sentence, and it is spent once per model. */
        Effect.zipRight(Effect.sleep('5 seconds')),
        Effect.zipRight(Fiber.interrupt(fiber))
      ),
    };
  });

/** Everything one conversation ended up with, for the checks and the table. */
interface Conversation {
  readonly said: readonly string[];
  readonly timings: readonly Timing[];
  readonly todos: readonly Todo[];
  /** The questions of each call the asker took, so a run can count both. */
  readonly asked: readonly (readonly Question[])[];
  readonly rounds: readonly { answering: readonly string[]; text: string }[];
  readonly refused: readonly string[];
  readonly reports: readonly SubagentReport[];
  readonly queuedId: string;
  readonly usage: ModelUsage;
  readonly turns: readonly Turn[];
  readonly reopened: string;
  readonly cloneUsage: ModelUsage | undefined;
  readonly summaries: number;
  readonly afterSummary: string;
  readonly seconds: number;
}

const isSummary = (turn: Turn): boolean => turn.parts.some(part => part.kind === 'summary');

/** The one call the clone makes, and what it was charged for it. */
const oneMore = (sessionId: string) =>
  Effect.gen(function* () {
    const clone = yield* cloneSession(sessionId);
    return yield* Stream.runFold(
      clone.ask('Answer with the word: ok', { maxTokens: 256 }),
      undefined as ModelUsage | undefined,
      (held, event) => (event.kind === 'done' ? event.usage : held)
    );
  });

/**
 * The whole conversation, for one model.
 *
 * The tools are built here rather than once for the run, because a tool holds
 * what it protects: one asker is one person, one list is one plan, and eleven
 * conversations running at once are eleven of each.
 */
const converse = (model: string) =>
  Effect.gen(function* () {
    const started = Date.now();
    const timings: Timing[] = [];
    const asked: Question[][] = [];
    const reports: SubagentReport[] = [];
    const list = yield* Ref.make<readonly Todo[]>([]);

    /* Slower than any model waits, so the answer lands in a round of its own. */
    const asker: Asker = questions =>
      Effect.gen(function* () {
        asked.push([...questions]);
        yield* Effect.sleep('5 seconds');
        return questions.map(
          (question): Answer => ({
            id: question.id,
            ...(question.choices?.[0] === undefined
              ? { text: 'ultramarine' }
              : { chosen: [question.choices[0].value] }),
          })
        );
      });

    const layers = kilo();
    const tools: readonly Tool[] = [
      timeTool({ zone: 'Europe/Amsterdam' }),
      todoTool({ onChanged: todos => Ref.set(list, todos) }),
      questionTool(asker, { inlineFor: Duration.seconds(1) }),
      subagentTool(
        {
          system: subSystem,
          model,
          /* Room for a model that thinks before it answers: at 256 tokens two
             of the eleven spent the lot on reasoning and came back empty. */
          maxTokens: 512,
          inlineFor: Duration.seconds(2),
          onFinished: report => Effect.sync(() => void reports.push(report)),
        },
        layers
      ),
    ];

    const database = new DatabaseSync(':memory:');
    const store = layerNodeStore(database);
    const registry = Layer.succeed(ToolRegistry, { tools });
    const everything = Layer.mergeAll(layers, store, registry);

    const conversation = Effect.gen(function* () {
      const session = yield* openSession({
        system,
        model,
        maxTokens: 1024,
        tools: ['time', 'todo', 'question', 'subagent'],
      });
      const watch = yield* watching(session, '180 seconds');

      const words: string[] = [];
      words.push(
        yield* timed(session, `Remember this for later: ${secret}. Reply with the word: noted`, timings)
      );
      words.push(yield* timed(session, 'What time is it right now? Give me the time.', timings));
      words.push(
        yield* timed(
          session,
          'Write my release plan down with the todo tool, as these three steps in ' +
            'this order: cut the branch, run the checks, publish the notes. Mark ' +
            'the first one as the one you are on. Then tell me the list.',
          timings
        )
      );
      words.push(
        yield* timed(
          session,
          'Now use the question tool once to ask me two things in that one call: ' +
            'which day to publish on, offering Tuesday and Thursday as choices, ' +
            'and which channel to announce in, offering email and chat as ' +
            'choices. Then tell me what I picked.',
          timings
        )
      );
      /* Typed while the question is still out, so it joins the line behind it. */
      const queuedId = yield* session.queue("Answer with the word 'pelican' and nothing else.");
      words.push(
        yield* timed(
          session,
          'What is the codename of the Acme Deploy 4.0 release? Hand that to a ' +
            'subagent and tell me what it says.',
          timings
        )
      );
      yield* watch.done;

      /* Asked before the summary as well as after it, because a fact the
         conversation has used twice is the fact a summariser must keep. */
      words.push(
        yield* timed(session, 'What is the staging database called? Answer with the one word.', timings)
      );

      const turns = yield* session.history;
      const usage = yield* session.usage;

      /* Reopened from SQLite, which is the only place the rounds the session
         ran on its own could have gone. */
      const reopened = yield* continueSession(session.id);
      const remembered = yield* timed(
        reopened,
        'What is the staging database called? Answer with the one word.',
        timings
      );

      const cloneUsage = yield* oneMore(session.id);

      /* Compacted on purpose, and then asked for the fact the summary had to
         keep. A harness changing subject does exactly this. */
      yield* reopened.compact;
      const afterSummary = yield* timed(
        reopened,
        'What is the staging database called? Answer with the one word.',
        timings
      );

      return {
        words,
        queuedId,
        usage,
        turns,
        reopened: remembered,
        cloneUsage,
        summaries: (yield* reopened.history).filter(isSummary).length,
        afterSummary,
        rounds: watch.rounds,
        refused: watch.refused,
      };
    });

    const got = yield* Effect.scoped(Effect.provide(conversation, everything));
    return {
      said: got.words,
      timings,
      todos: yield* Ref.get(list),
      asked,
      rounds: got.rounds,
      refused: got.refused,
      reports,
      queuedId: got.queuedId,
      usage: got.usage,
      turns: got.turns,
      reopened: got.reopened,
      cloneUsage: got.cloneUsage,
      summaries: got.summaries,
      afterSummary: got.afterSummary,
      seconds: (Date.now() - started) / 1000,
    } satisfies Conversation;
  });

/** Nothing at all, for a model whose conversation never started. */
const nothing: Conversation = {
  said: [],
  timings: [],
  todos: [],
  asked: [],
  rounds: [],
  refused: ['the conversation failed'],
  reports: [],
  queuedId: '',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  turns: [],
  reopened: '',
  cloneUsage: undefined,
  summaries: 0,
  afterSummary: '',
  seconds: 0,
};

/** One bad minute at a provider is not a defect, so a failed call is retried once. */
const held = (model: string): Promise<Conversation> =>
  Effect.runPromise(
    Effect.retry(converse(model), Schedule.once).pipe(
      Effect.catchAll(cause =>
        Effect.succeed({ ...nothing, refused: [`the conversation failed: ${String(cause)}`] })
      )
    )
  );

const median = (taken: readonly number[]): number =>
  taken.length === 0 ? 0 : (taken.toSorted((a, b) => a - b)[Math.floor(taken.length / 2)] ?? 0);

const pad = (text: string, width: number): string => text.padEnd(width);
const ms = (taken: number): string => `${taken.toFixed(0)}ms`;

/** What the whole conversation is allowed to cost, per model. */
const slowestFirstWord = 30_000;
const slowestConversation = 300;

const rows = await Promise.all(models.map(async model => ({ model, got: await held(model) })));

console.log(
  `\n${pad('model', 32)}${pad('turns', 6)}${pad('todo', 6)}${pad('asked', 7)}` +
    `${pad('rounds', 8)}${pad('sub', 5)}${pad('kept', 6)}${pad('first', 9)}` +
    `${pad('whole', 9)}${pad('ratio', 8)}total`
);

for (const { model, got } of rows) {
  under(model);
  const kept =
    got.reopened.toLowerCase().includes('quokka') && got.afterSummary.toLowerCase().includes('quokka');
  console.log(
    pad(model, 32) +
      pad(String(got.turns.length), 6) +
      pad(String(got.todos.length), 6) +
      pad(String(got.asked.flat().length), 7) +
      pad(String(got.rounds.length), 8) +
      pad(String(got.reports.length), 5) +
      pad(kept ? 'yes' : 'NO', 6) +
      pad(ms(median(got.timings.map(one => one.first))), 9) +
      pad(ms(median(got.timings.map(one => one.whole))), 9) +
      pad(hitRatio(got.usage).toFixed(3), 8) +
      `${got.seconds.toFixed(0)}s`
  );

  /* `KILO_SHOW=1` prints the conversation itself. A table says a model held it
     together; only the words say what it was like to talk to. */
  if (process.env['KILO_SHOW'] === '1') {
    console.log('  said  ', JSON.stringify(got.said));
    console.log('  rounds', JSON.stringify(got.rounds.map(round => round.text)));
  }

  /* Correctness. Every one of these is a promise the package makes. */
  wrongIf(got.refused.length > 0, `a round was refused: ${got.refused.join('; ')}`);
  /* One turn may say nothing: a model that hands a call to the background has
     answered by starting the work, and its words arrive in the round. Two is a
     model that stopped talking to the person. */
  const silent = got.said.filter(one => one.trim() === '').length;
  wrongIf(silent > 2, `${String(silent)} of the answers carried no text`);
  wrongIf(got.todos.length < 3, `the plan was written down as ${String(got.todos.length)} steps, not three or more`);
  const questions = got.asked.flat();
  wrongIf(
    got.asked.length !== 1,
    `the person was interrupted ${String(got.asked.length)} times, not asked once`
  );
  wrongIf(
    questions.length < 2,
    `the one call asked ${String(questions.length)} things, not the two it was given`
  );
  wrongIf(
    questions.some(one => one.choices === undefined),
    'a question was asked without the choices it was given'
  );
  wrongIf(
    got.rounds.length === 0,
    'the session ran no rounds of its own, though a message waited while it was busy'
  );
  wrongIf(
    !got.rounds.some(round => round.answering.includes(got.queuedId)),
    'the message typed while the session was busy was never answered'
  );
  wrongIf(
    !got.rounds.some(round => round.text.toLowerCase().includes('pelican')),
    'the answer to the queued message never carried its word'
  );
  /* Whether a model hands the lookup down at all is the model's choice, and
     `pnpm test:e2e:tool-matrix` is the run that scores it. What is asserted
     here is the package's half: a subagent that ran came back with the answer,
     and that answer reached the parent's conversation. */
  wrongIf(
    got.reports.some(report => !report.said.toLowerCase().includes(codename)),
    'a subagent finished without the answer it was sent for'
  );
  /* Read out of the parent's own transcript rather than out of its words.
     Carrying the answer back into the conversation is what the package
     promises; repeating it to the person is the model's own manner. */
  const transcript = got.turns
    .flatMap(turn => turn.parts.map(part => part.body))
    .join(' ')
    .toLowerCase();
  wrongIf(
    got.reports.length > 0 && !transcript.includes(codename),
    "the subagent answered and its answer never reached the parent's conversation"
  );
  wrongIf(
    got.reports[0]?.usage.outputTokens === 0,
    'the subagent reported no counts, so a caller adding up the conversation would be short'
  );
  wrongIf(
    !got.reopened.toLowerCase().includes('quokka'),
    `the reopened session answered ${JSON.stringify(got.reopened)}, so the store lost the conversation`
  );
  wrongIf(got.summaries === 0, 'compacting left no summary in the transcript');
  wrongIf(
    !got.afterSummary.toLowerCase().includes('quokka'),
    `after the summary the session answered ${JSON.stringify(got.afterSummary)}, so the summariser dropped what the next turn needed`
  );
  const read = got.cloneUsage?.cacheReadTokens ?? 0;
  const written = got.cloneUsage?.cacheWriteTokens ?? 0;
  wrongIf(read === 0, 'the clone read nothing from the cache, so it paid for the prefix twice');
  wrongIf(
    written > read / 4,
    `the clone wrote ${String(written)} against ${String(read)} read, so it did not inherit the prefix`
  );

  /* Performance. Generous, and about this package rather than the provider. */
  wrongIf(
    median(got.timings.map(one => one.first)) > slowestFirstWord,
    `the median first word took ${ms(median(got.timings.map(one => one.first)))}, over ${ms(slowestFirstWord)}`
  );
  wrongIf(
    got.seconds > slowestConversation,
    `the conversation took ${got.seconds.toFixed(0)}s, over ${String(slowestConversation)}s`
  );
  wrongIf(
    hitRatio(got.usage) < 0.3,
    `the conversation read ${hitRatio(got.usage).toFixed(3)} of its prompt from the cache, under 0.3`
  );
}

under('');
passed('every model held one whole conversation: tools, a person, a subagent, the store, and a summary');
