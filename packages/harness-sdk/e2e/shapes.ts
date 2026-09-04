/**
 * Proves the two shapes the live runs never reach.
 *
 * Every model in `models.ts` picks `messages`, because the gateway serves it
 * for all of them and it caches best. So `responses` and `chat_completions`
 * have only ever run against a fake `fetch`. This run forces each shape by
 * telling the catalog that the model speaks only that one, and asks the same
 * two questions the messages run asks.
 *
 * The three shapes do not cache alike, and the assertions say so:
 *
 * - `messages` marks an explicit breakpoint, so it must read the cache.
 * - `responses` names a `prompt_cache_key`, so it should read the cache.
 * - `chat_completions` has no cache control at all, so the only thing worth
 *   asserting is that the call works and the conversation carries.
 */
import assert from 'node:assert/strict';
import { Effect, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import type { ModelUsage } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import { hitRatio } from '../src/core/usage.js';
import { cachedSystem as system, kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'openai/gpt-5.6-luna';

interface Answer {
  readonly said: string;
  readonly usage: ModelUsage | undefined;
}

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text), { said: '', usage: undefined } as Answer, (held, event) =>
    event.kind === 'delta'
      ? { ...held, said: held.said + event.text }
      : event.kind === 'done'
        ? { ...held, usage: event.usage }
        : held
  );

const runShape = async (kind: ApiKind) => {
  const layers = kilo({ apiKinds: [kind] });

  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 64 });
    const first = yield* ask(session, 'Answer with the word: one');
    const second = yield* ask(session, 'Answer with the word: two');
    return { first, second, total: yield* session.usage };
  });

  return Effect.runPromise(Effect.either(Effect.scoped(Effect.provide(program, layers))));
};

const kinds: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];
/** `chat_completions` sends no cache control, so it is not held to a ratio. */
const mustCache = new Set<ApiKind>(['messages', 'responses']);

console.log('model', model);
console.log('\nshape             answered  cache read  input   ratio');

const failures: string[] = [];

for (const kind of kinds) {
  const result = await runShape(kind);
  if (result._tag === 'Left') {
    console.log(`${kind.padEnd(18)}FAILED    ${JSON.stringify(result.left)}`);
    failures.push(`${kind}: the call failed`);
    continue;
  }

  const { first, second, total } = result.right;
  const ratio = hitRatio(total);
  const answered = first.said.length > 0 && second.said.length > 0;
  console.log(
    `${kind.padEnd(18)}${String(answered).padEnd(10)}${String(total.cacheReadTokens).padEnd(12)}` +
      `${String(total.inputTokens).padEnd(8)}${ratio.toFixed(4)}`
  );

  if (!answered) {
    failures.push(`${kind}: an answer carried no text`);
  }
  if (mustCache.has(kind) && total.cacheReadTokens === 0) {
    failures.push(
      `${kind}: nothing was read from the cache, and this shape controls one. ` +
        'An Anthropic model on the responses shape caches nothing on this gateway, ' +
        'measured 2026-09-04; see AGENTS.md. Anything else here is a regression.'
    );
  }
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log(
  '\nPASS: every shape carried the conversation, and both cache-controlling shapes cached.'
);
