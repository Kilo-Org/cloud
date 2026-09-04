/**
 * Proves the two things a session does on its own share one line, in order.
 *
 * A late tool result and a queued message are the same thing to the session: a
 * message it must say when it is free. They are held in one line so the order
 * between them is defined rather than a race, and this run makes them contend
 * for it — the answer to a question the model asked, and a message a person
 * typed after it, both waiting while the session is busy with a third thing.
 *
 * One session, three rounds:
 *
 * - **Several questions in one call.** The model is asked to find out two
 *   things, and the tool takes both at once, with choices. That is the question
 *   tool's richer shape, exercised by a model rather than by a test.
 * - **The answer outlives the request.** The asker takes far longer than the
 *   model waits, so the model is told the question is out and answers without
 *   it.
 * - **A slow message is queued**, and while its round runs the answer lands in
 *   the line behind it. A second message is queued only once the line is seen
 *   holding that answer, so the two are certainly waiting together.
 * - **The order is the order they joined.** The slow message, then the answer,
 *   then the message typed after it — and each round names what it answers.
 */
import assert from 'node:assert/strict';
import { Duration, Effect, Layer, Schedule, Stream } from 'effect';
import type { SessionHandle } from '../src/core/handle.js';
import type { Continued, Waiting } from '../src/core/queue.js';
import { openSession } from '../src/core/run.js';
import { type Tool, ToolRegistry } from '../src/core/tool.js';
import {
  type Answer,
  type Asker,
  type Question,
  questionTool,
} from '../src/plugins/tools/question.js';
import { kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

const system =
  'You are a test harness with tools. Call a tool whenever the person names ' +
  'one. When you need something only the person knows, ask with the question ' +
  'tool, and ask everything you need in one call. Answer in one or two short ' +
  "sentences, repeating the person's own words.";

const opening =
  'I want a bicycle. Use the question tool once to ask me two questions in ' +
  'that one call: which colour I want, offering ultramarine and vermilion as ' +
  'choices, and which animal should be on the bell, offering marmoset and ' +
  'kestrel as choices. Then tell me what I picked.';

/* Slow on purpose, and slow by the clock rather than by the token: its round
   must still be running when the answer lands, or the two never wait in the
   line together and the order is not under test. A model asked for a long
   answer writes it in a couple of seconds; a tool that sleeps holds the round
   for as long as it says. */
const slowly = "Call the wait tool once. When it answers, answer with the word 'narwhal'.";

const after = "Answer with the word 'pelican' and nothing else.";

/** What the model actually asked for, kept so the run can say what it saw. */
const takenUp: Question[][] = [];

/** Picks the first choice of every question, slower than any model waits. */
const asker: Asker = questions =>
  Effect.gen(function* () {
    takenUp.push([...questions]);
    yield* Effect.sleep('6 seconds');
    return questions.map(
      (question): Answer => ({
        id: question.id,
        ...(question.choices === undefined || question.choices[0] === undefined
          ? { text: 'ultramarine' }
          : { chosen: [question.choices[0].value] }),
      })
    );
  });

/** Holds a round open for a known time, so the line is certainly contended. */
const waitTool: Tool = {
  definition: {
    name: 'wait',
    description: 'Waits a while and then answers. Takes nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  run: () => Effect.as(Effect.sleep('10 seconds'), 'Waited.'),
};

const tools = Layer.succeed(ToolRegistry, {
  tools: [questionTool(asker, { inlineFor: Duration.millis(500) }), waitTool],
});

/** What one round the session ran on its own said, and which message it answers. */
interface Round {
  readonly answering: readonly string[];
  readonly text: string;
}

/** The event of one thing that happened, or nothing when the round failed. */
const eventIn = (one: Continued) => ('failed' in one ? undefined : one.event);

/**
 * True when a round is over rather than paused on a tool.
 *
 * `done` ends one call to the model, and a round that calls a tool makes
 * several. `tools` is the model waiting on a call the session is about to
 * answer, so it is the one stop reason that is not the end of anything. This is
 * how a caller knows a queued message has been answered in full.
 */
const over = (one: Continued): boolean => {
  const event = eventIn(one);
  return event?.kind === 'done' && event.stop !== 'tools';
};

/** The rounds that were refused rather than answered. Empty is the healthy shape. */
const refused: (readonly string[])[] = [];

/** Collects the rounds the session runs on its own, until `count` have ended. */
const watch = (session: SessionHandle, count: number) => {
  const rounds: Round[] = [];
  let ended = 0;
  const held = { answering: [] as readonly string[], text: '' };
  return Stream.runForEach(
    Stream.takeUntil(session.continued, one => over(one) && ++ended === count),
    (one: Continued) =>
      Effect.sync(() => {
        held.answering = one.answering;
        const event = eventIn(one);
        if (event?.kind === 'delta') {
          held.text += event.text;
        }
        /* A refused round is one message's bad news, not the end of the feed.
           The run says so rather than waiting for words that never come. */
        if ('failed' in one) {
          refused.push(one.answering);
        }
        if (over(one) || 'failed' in one) {
          rounds.push({ answering: held.answering, text: held.text });
          held.text = '';
        }
      })
  ).pipe(Effect.as(rounds));
};

const said = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text), '', (held: string, event) =>
    event.kind === 'delta' ? held + event.text : held
  );

/**
 * Waits until the line holds the answer to the question, and says what it held.
 *
 * It watches the line rather than the clock. Queueing the second message on a
 * timer would prove nothing on a slow day: the two must be seen waiting
 * together, or the order between them was never tested.
 */
const untilAnswerWaits = (session: SessionHandle) =>
  Effect.retry(
    Effect.filterOrFail(
      session.queued,
      waiting => waiting.some(one => one.kind === 'toolResult'),
      () => 'not yet' as const
    ),
    Schedule.spaced('100 millis').pipe(Schedule.upTo('60 seconds'))
  );

/** The line entry that carries the answer to the question. */
const answerIn = (waiting: readonly Waiting[]): Waiting | undefined =>
  waiting.find(one => one.kind === 'toolResult');

const program = Effect.gen(function* () {
  const session = yield* openSession({
    system,
    model,
    maxTokens: 512,
    tools: ['question', 'wait'],
  });
  const watching = yield* Effect.fork(Effect.timeout(watch(session, 3), '180 seconds'));
  const first = yield* said(session, opening);
  /* The question is still out: the asker sleeps longer than the model waited. */
  const long = yield* session.queue(slowly);
  const waiting = yield* untilAnswerWaits(session);
  const last = yield* session.queue(after);
  const both = yield* session.queued;
  const rounds = yield* watching.await;
  return { first, long, last, waiting, both, rounds };
});

const got = await Effect.runPromise(
  Effect.scoped(Effect.provide(program, tools.pipe(Layer.merge(kilo()))))
);

const failures: string[] = [];
const wrongIf = (broken: boolean, why: string): void => {
  if (broken) {
    failures.push(why);
  }
};

const rounds = got.rounds._tag === 'Success' ? got.rounds.value : [];
const askedFor = takenUp[0] ?? [];

const answered = answerIn(got.waiting);

/**
 * Every identifier waiting in the line, in the order it joined.
 *
 * An identifier is made when its entry joins and sorts by when it was made, so
 * sorting them is the join order. Reading it off a snapshot of the line would
 * not do: by the time the caller looks, the session may already have taken the
 * first one out.
 */
const joined = [got.long, got.last, answered?.id ?? ''].filter(id => id !== '').toSorted();

/** What one identifier stands for, in words, so a failure reads as an order. */
const idMarks = (id: string | undefined): string => {
  if (id === got.long) {
    return 'the slow message';
  }
  if (id === got.last) {
    return 'the message typed after';
  }
  return 'the late answer';
};

const marks = (round: Round | undefined): string => idMarks(round?.answering[0]);

/** What the session said in the round that answered one identifier. */
const textFor = (id: string): string | undefined =>
  rounds.find(round => round.answering.includes(id))?.text;

console.log('model', model);
console.log(`\nasked in one call: ${String(askedFor.length)} questions`);
for (const question of askedFor) {
  const choices = (question.choices ?? []).map(one => one.value).join(', ');
  console.log(`  [${question.id}] ${question.prompt} {${choices}}`);
}
console.log(`\nanswered without waiting: ${JSON.stringify(got.first.trim())}`);
console.log(
  `\nthe line, once the answer had joined it: ${JSON.stringify(got.waiting.map(one => one.kind))}`
);
console.log(
  `and once a message was typed after it:  ${JSON.stringify(got.both.map(one => one.kind))}`
);
for (const [at, round] of rounds.entries()) {
  const text = round.text.trim().replaceAll('\n', ' ');
  const shown = text.length > 90 ? `${text.slice(0, 90)}…` : text;
  console.log(`\nround ${String(at + 1)} (${marks(round)}): ${JSON.stringify(shown)}`);
}

wrongIf(takenUp.length !== 1, `the tool was called ${String(takenUp.length)} times, not once`);
wrongIf(askedFor.length < 2, 'the model did not put both questions in one call');
wrongIf(
  !askedFor.some(question => (question.choices ?? []).length > 1),
  'the model asked nothing with choices, so the richer shape never ran'
);
wrongIf(
  got.first.toLowerCase().includes('ultramarine'),
  'the model was given the answer inline, so nothing was backgrounded'
);
wrongIf(
  answered === undefined,
  'the answer never waited in the line, so nothing ever contended for it'
);
wrongIf(got.rounds._tag !== 'Success', 'the session never finished three rounds of its own');
wrongIf(
  rounds.length !== 3,
  `the session ran ${String(rounds.length)} rounds of its own, not three`
);
/* The one claim this run exists for. The identifiers are made in the order
   they join the line and sort that way, so their order is the order the
   session owes them, whatever the model's speed did to the clock. */
wrongIf(
  JSON.stringify(rounds.map(round => round.answering)) !== JSON.stringify(joined.map(id => [id])),
  `the rounds answered ${JSON.stringify(rounds.map(marks))}, not ${JSON.stringify(joined.map(idMarks))}`
);
wrongIf(
  !(textFor(got.long) ?? '').toLowerCase().includes('narwhal'),
  'the message that held the session open was not answered'
);
wrongIf(
  !(textFor(answered?.id ?? '') ?? '').toLowerCase().includes('ultramarine'),
  'the session never told the model what the person answered'
);
wrongIf(
  !(textFor(got.last) ?? '').toLowerCase().includes('pelican'),
  'the message typed after the answer was never answered'
);

wrongIf(
  refused.length > 0,
  `the session was refused ${String(refused.length)} of the rounds it ran on its own`
);

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log(
  '\nPASS: two questions went out in one call, and a late answer and a typed ' +
    'message waited in one line and were said in the order they joined it.'
);
