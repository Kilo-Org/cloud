import { Effect, Layer, Stream } from 'effect';
import { Chunk } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { Effort, ModelUsage } from '../src/core/model.js';
import { openSession, type SessionHandle } from '../src/core/run.js';
import { hitRatio } from '../src/core/usage.js';
import { layerKiloGateway } from '../src/plugins/gateway/index.js';
import { layerAssembler } from '../src/plugins/prompt/default.js';
import { layerTableCatalog } from '../src/plugins/catalog/table.js';
import { layerStaticToken } from '../src/plugins/token/static.js';
import { layerBackoff } from '../src/plugins/retry/backoff.js';
import { kiloToken, nodeFetch } from './node-fetch.js';

/**
 * The ten most used models on OpenRouter this week. Every one is cheap: the
 * dearest input is `tencent/hy4-preview` at 0.83 dollars for a million tokens.
 * `deepseek-v4-flash-0423` is not served, so the floating alias stands in.
 */
const models = [
  'openai/gpt-5.6-luna',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-0731',
  'tencent/hy4-preview',
  'xiaomi/mimo-v2.5',
  'tencent/hy3',
  'deepseek/deepseek-v4-flash',
  'minimax/minimax-m3',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'google/gemini-3.7-flash',
] as const;

const chosen = process.env['KILO_MODELS']?.split(',') ?? models;
/**
 * A reasoning model spends the budget on reasoning before it writes a word. At
 * 64 tokens four of these ten answered nothing at all, which reads as a broken
 * transport and is not one.
 */
const maxTokens = Number(process.env['KILO_MAX_TOKENS'] ?? '1024');
const effort = process.env['KILO_EFFORT'] as Effort | undefined;

const rule = (index: number) =>
  `Rule ${String(index)}: when the user asks for a word, answer with that one word and nothing else. ` +
  'Do not explain. Do not add punctuation beyond the word itself. Do not greet the user. ' +
  'Do not restate the question. Keep the answer to a single lowercase word.';

const system = [
  'You are a test harness. Follow every rule below.',
  ...Array.from({ length: 200 }, (_, index) => rule(index)),
].join('\n');

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
}

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text), { said: '', usage: undefined } as Answer, (held, event) =>
    event.kind === 'delta'
      ? { ...held, said: held.said + event.text }
      : { ...held, usage: event.usage }
  );

const converse = (model: string, kinds: readonly ApiKind[], token: string) => {
  /** Both the session and the gateway ask the catalog, so it is shared, not nested. */
  const catalog = layerTableCatalog({}, { apiKinds: kinds });
  return Effect.scoped(
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
        turns: Chunk.size(yield* session.history),
        total: yield* session.usage,
      };
    })
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerAssembler,
        catalog,
        layerKiloGateway({
          baseUrl: process.env['KILO_BASE_URL'] ?? 'https://app.kilo.ai',
          org: {
            kind: 'organization',
            id: process.env['KILO_ORG_ID'] ?? '9d278969-5453-4ae3-a51f-a8d2274a7b56',
          },
          fetch: nodeFetch,
        }).pipe(Layer.provide(Layer.mergeAll(catalog, layerStaticToken(token), layerBackoff())))
      )
    )
  );
};

const token = await kiloToken();

const preferred: readonly ApiKind[] = (process.env['KILO_KINDS']?.split(',') as
  | ApiKind[]
  | undefined) ?? ['messages', 'responses', 'chat_completions'];

/** Tries the best shape first. A model whose provider rejects it falls back. */
const run = (model: string) =>
  converse(model, preferred, token).pipe(
    Effect.map(result => ({ model, kind: preferred[0] ?? 'messages', result })),
    Effect.catchAll(first =>
      converse(model, ['chat_completions'], token).pipe(
        Effect.map(result => ({ model, kind: 'chat_completions' as ApiKind, result })),
        Effect.catchAll(second =>
          Effect.succeed({ model, kind: 'failed' as const, errors: [first, second] })
        )
      )
    )
  );

const outcomes = await Effect.runPromise(Effect.forEach(chosen, run, { concurrency: 3 }));

const pad = (text: string, width: number) => text.padEnd(width);
console.log(
  `\n${pad('model', 34)}${pad('shape', 17)}${pad('turns', 6)}${pad('recalled', 9)}${pad('cache read', 11)}${pad('input', 8)}ratio`
);

let broken = 0;
for (const outcome of outcomes) {
  if (outcome.kind === 'failed') {
    broken += 1;
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
    broken += 1;
    console.log(`  ${outcome.model}: empty answers at turns ${empty.join(', ')}`);
    console.log(`  said: ${JSON.stringify(answers.map(answer => answer.said))}`);
  }
  console.log(
    pad(outcome.model, 34) +
      pad(outcome.kind, 17) +
      pad(String(turns), 6) +
      pad(recalled, 9) +
      pad(String(total.cacheReadTokens), 11) +
      pad(String(total.inputTokens), 8) +
      hitRatio(total).toFixed(4)
  );
}

console.log(
  `\n${String(chosen.length - broken)} of ${String(chosen.length)} models answered every turn.`
);
if (broken > 0) {
  process.exitCode = 1;
}
