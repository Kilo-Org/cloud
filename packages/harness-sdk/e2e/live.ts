import assert from 'node:assert/strict';
import { Effect, Layer, Stream } from 'effect';
import { openSession, type SessionHandle } from '../src/core/run.js';
import type { ModelUsage } from '../src/core/model.js';
import { hitRatio } from '../src/core/usage.js';
import { layerKiloGateway } from '../src/plugins/gateway/index.js';
import { layerAssembler } from '../src/plugins/prompt/default.js';
import { layerTableCatalog } from '../src/plugins/catalog/table.js';
import { layerStaticToken } from '../src/plugins/token/static.js';
import { layerBackoff } from '../src/plugins/retry/backoff.js';
import { kiloToken, nodeFetch } from './node-fetch.js';

const baseUrl = process.env['KILO_BASE_URL'] ?? 'https://app.kilo.ai';
const organizationId = process.env['KILO_ORG_ID'] ?? '9d278969-5453-4ae3-a51f-a8d2274a7b56';
const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

/**
 * The cached prefix must clear the model's minimum, which is 4096 tokens on
 * Haiku 4.5. A short system prompt caches nothing at all and the check would
 * read as a failure of the package rather than of the prompt.
 */
const rule = (index: number) =>
  `Rule ${String(index)}: when the user asks for a word, answer with that one word and nothing else. ` +
  'Do not explain. Do not add punctuation beyond the word itself. Do not greet the user. ' +
  'Do not restate the question. Keep the answer to a single lowercase word.';

const system = [
  'You are a test harness. Follow every rule below.',
  ...Array.from({ length: 200 }, (_, index) => rule(index)),
].join('\n');

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

const program = Effect.gen(function* () {
  const session = yield* openSession({ system, model, maxTokens: 32 });
  const first = yield* ask(session, 'Answer with the word: one');
  const second = yield* ask(session, 'Answer with the word: two');
  return { id: session.id, first, second, total: yield* session.usage };
});

/** Both the session and the gateway ask the catalog, so it is shared, not nested. */
const catalog = layerTableCatalog({}, { apiKinds: ['messages', 'responses', 'chat_completions'] });

const layers = Layer.mergeAll(
  layerAssembler,
  catalog,
  layerKiloGateway({
    baseUrl,
    org: { kind: 'organization', id: organizationId },
    fetch: nodeFetch,
  }).pipe(
    Layer.provide(Layer.mergeAll(catalog, layerStaticToken(await kiloToken()), layerBackoff()))
  )
);

const result = await Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));

console.log('session   ', result.id);
console.log('model     ', model);
console.log('first     ', JSON.stringify(result.first.said), result.first.usage);
console.log('second    ', JSON.stringify(result.second.said), result.second.usage);
console.log('cumulative', result.total, 'hit ratio', hitRatio(result.total).toFixed(4));

assert.ok(result.first.said.length > 0, 'the first answer carried no text');
assert.ok(result.second.said.length > 0, 'the second answer carried no text');

const second = result.second.usage;
assert.ok(second !== undefined, 'the second answer carried no token counts');
assert.ok(second.cacheReadTokens > 0, 'the second call read nothing from the cache');
assert.ok(
  hitRatio(second) > 0.95,
  `the cache hit ratio was ${hitRatio(second).toFixed(4)}, which is not above 0.95`
);

console.log('\nPASS: the second call read the prefix from the cache.');
