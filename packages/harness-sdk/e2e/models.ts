import { Effect, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { Effort, ModelUsage } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import { hitRatio } from '../src/core/usage.js';
import { cachedSystem as system, kilo, models, room } from './setup.js';

/**
 * The same five questions, put to every model in the list.
 *
 * The list is one model unless the run is asked for `full` — see `e2e/setup.ts`
 * — so this is a cheap check by default and the vendor sweep on request.
 *
 * A reasoning model spends the budget on reasoning before it writes a word. At
 * 64 tokens four of the eleven answered nothing at all, which reads as a broken
 * transport and is not one.
 */
const maxTokens = Number(process.env['KILO_MAX_TOKENS'] ?? String(room));
const effort = process.env['KILO_EFFORT'] as Effort | undefined;

/** The last question can only be answered from the history of the session. */
const questions = [
  'Remember the word pineapple. Answer with the word: ok',
  'Answer with the word: one',
  'Answer with the word: two',
  'Answer with the word: three',
  'Which word did I ask you to remember? Answer with that one word.',
] as const;

interface Answer {
  readonly said: string;
  readonly usage: ModelUsage | undefined;
  /** Milliseconds from the question to the first piece of the answer. */
  readonly first: number;
  /** Milliseconds from the question to the end of the answer. */
  readonly whole: number;
}

const blank: Answer = { said: '', usage: undefined, first: 0, whole: 0 };

/**
 * Times the answer as a caller sees it. The clock starts when `ask` is called,
 * not when the request leaves, so assembling the prompt is counted too: that
 * is the part of the wait this package can do something about.
 */
const ask = (session: SessionHandle, text: string) =>
  Effect.suspend(() => {
    const started = performance.now();
    return Stream.runFold(
      session.ask(text),
      () => blank,
      (held, event) =>
        event.kind === 'delta'
          ? {
              ...held,
              said: held.said + event.text,
              first: held.first === 0 ? performance.now() - started : held.first,
            }
          : event.kind === 'done'
            ? { ...held, usage: event.usage, whole: performance.now() - started }
            : held
    );
  });

const converse = (model: string, kinds: readonly ApiKind[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openSession({
        system,
        model,
        maxTokens,
        ...(effort === undefined ? {} : { effort }),
      });
      const answers: Answer[] = [];
      for (const question of questions) {
        answers.push(yield* ask(session, question));
      }
      return {
        answers,
        turns: (yield* session.history).length,
        total: yield* session.usage,
      };
    })
  ).pipe(Effect.provide(kilo({ apiKinds: kinds })));

const preferred: readonly ApiKind[] = (process.env['KILO_KINDS']?.split(',') as
  | ApiKind[]
  | undefined) ?? ['messages', 'responses', 'chat_completions'];

/** The five answers, what the session kept, and what the provider counted. */
interface Conversation {
  readonly answers: readonly Answer[];
  readonly turns: number;
  readonly total: ModelUsage;
}

/** One model's whole run, or the two calls that failed rather than answered. */
type Outcome =
  | { readonly model: string; readonly kind: ApiKind; readonly result: Conversation }
  | { readonly model: string; readonly kind: 'failed'; readonly errors: readonly unknown[] };

/** Tries the best shape first. A model whose provider rejects it falls back. */
const run = (model: string): Effect.Effect<Outcome> =>
  converse(model, preferred).pipe(
    Effect.map(result => ({ model, kind: preferred[0] ?? 'messages', result })),
    Effect.catch(first =>
      converse(model, ['chat_completions']).pipe(
        Effect.map(result => ({ model, kind: 'chat_completions' as ApiKind, result })),
        Effect.catch(second =>
          Effect.succeed({ model, kind: 'failed' as const, errors: [first, second] })
        )
      )
    )
  );

/**
 * One model, tried once more when it left a turn unanswered.
 *
 * A silent turn is the model's own answer rather than the package's: measured,
 * the same model on the same five questions answers the turn on the next run and
 * not on this one. So a conversation that came back with a blank answer is tried
 * once more before it counts, and only a second one is a finding — the rule
 * `e2e/live.ts` and `e2e/time.ts` already keep. A refused call is not this:
 * `run` has already put it on the other shape.
 *
 * The whole conversation runs again rather than the empty turn on its own: the
 * run holds the session to two turns per question, and a second ask would leave
 * it four turns past that and report a fault this package does not have.
 */
const settled = (model: string) =>
  Effect.gen(function* () {
    const first = yield* run(model);
    const blank =
      first.kind !== 'failed' && first.result.answers.some(answer => answer.said.trim() === '');
    if (!blank) {
      return first;
    }
    console.log(`  ${model}: a turn came back empty, so the run was tried once more`);
    return yield* run(model);
  });

const outcomes = await Effect.runPromise(Effect.forEach(models, settled, { concurrency: 3 }));

const pad = (text: string, width: number) => text.padEnd(width);
const ms = (taken: number) => `${taken.toFixed(0)}ms`;

/** The middle answer, so one slow call does not stand for the whole run. */
const median = (taken: readonly number[]) =>
  taken.toSorted((a, b) => a - b)[Math.floor(taken.length / 2)] ?? 0;

console.log(
  `\n${pad('model', 34)}${pad('shape', 17)}${pad('recalled', 9)}` +
    `${pad('first', 8)}${pad('whole', 8)}${pad('cache read', 11)}${pad('input', 8)}ratio`
);

/* One entry per model, not per fault: a model that both left a turn empty and
   kept the wrong number of turns is one model that did not carry the
   conversation, and the line at the end counts models. */
const broken = new Set<string>();
for (const outcome of outcomes) {
  if (outcome.kind === 'failed') {
    broken.add(outcome.model);
    console.log(
      `${pad(outcome.model, 34)}${pad('FAILED', 17)}${JSON.stringify(outcome.errors[0])}`
    );
    continue;
  }
  const { answers, turns, total } = outcome.result;
  const recalled = /pineapple/iu.test(answers.at(-1)?.said ?? '') ? 'yes' : 'no';
  const empty = answers
    .map((answer, index) => (answer.said.trim() === '' ? index : -1))
    .filter(index => index >= 0);
  if (empty.length > 0) {
    broken.add(outcome.model);
    console.log(`  ${outcome.model}: empty answers at turns ${empty.join(', ')}, twice over`);
    console.log(`  said: ${JSON.stringify(answers.map(answer => answer.said))}`);
  }
  if (turns !== questions.length * 2) {
    broken.add(outcome.model);
    console.log(
      `  ${outcome.model}: kept ${String(turns)} turns, not ${String(questions.length * 2)}`
    );
  }
  console.log(
    pad(outcome.model, 34) +
      pad(outcome.kind, 17) +
      pad(recalled, 9) +
      pad(ms(median(answers.map(answer => answer.first))), 8) +
      pad(ms(median(answers.map(answer => answer.whole))), 8) +
      pad(String(total.cacheReadTokens), 11) +
      pad(String(total.inputTokens), 8) +
      hitRatio(total).toFixed(4)
  );
}

console.log(
  `\n${String(models.length - broken.size)} of ${String(models.length)} models answered every turn.`
);
if (broken.size > 0) {
  process.exitCode = 1;
}
