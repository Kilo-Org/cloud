/**
 * Proves the model's thinking goes back to the provider and is accepted.
 *
 * The unit tests prove the block survives the round trip through this package.
 * They cannot prove the provider agrees, and the provider is the only judge:
 * it signs a thinking block and refuses one whose signature it cannot read.
 *
 * So the run asks a reasoning model two questions in one session. The second
 * request carries the first answer's thinking block. If the block were wrong —
 * a signature this package dropped, text this package edited, a block put in
 * the wrong place — the second call would fail, not answer differently.
 */
import assert from 'node:assert/strict';
import { Effect, Layer, Stream } from 'effect';
import type { ModelUsage } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { Turn } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/wiring.js';
import { layerTableCatalog } from '../src/plugins/catalog/table.js';
import { layerWebCrypto } from '../src/plugins/entropy/web-crypto.js';
import { layerKiloGateway } from '../src/plugins/gateway/index.js';
import { layerAssembler } from '../src/plugins/prompt/default.js';
import { layerBackoff } from '../src/plugins/retry/backoff.js';
import { layerStaticToken } from '../src/plugins/token/static.js';
import { kiloToken, nodeFetch } from './node-fetch.js';

const baseUrl = process.env['KILO_BASE_URL'] ?? 'https://app.kilo.ai';
const organizationId = process.env['KILO_ORG_ID'] ?? '9d278969-5453-4ae3-a51f-a8d2274a7b56';
/** A model that thinks. A model that does not would pass this run vacuously. */
const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-sonnet-4.5';

const system = 'You answer briefly. Think first, then give the answer in one short sentence.';

/** Two questions that are worth thinking about, and that follow on. */
const first = 'A farmer has 17 sheep. All but 9 run away. How many are left? Explain in one line.';
const second = 'Now double that number and tell me the result.';

interface Answer {
  readonly said: string;
  readonly thought: string;
  readonly usage: ModelUsage | undefined;
}

const empty: Answer = { said: '', thought: '', usage: undefined };

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text, { maxTokens: 4000 }), empty, (held, event) => {
    switch (event.kind) {
      case 'delta': {
        return { ...held, said: held.said + event.text };
      }
      case 'reasoning': {
        return { ...held, thought: held.thought + event.text };
      }
      case 'done': {
        return { ...held, usage: event.usage };
      }
    }
  });

const catalog = layerTableCatalog({}, { apiKinds: ['messages'] });
const layers = Layer.mergeAll(
  layerAssembler,
  layerWebCrypto,
  catalog,
  layerKiloGateway({
    baseUrl,
    org: { kind: 'organization', id: organizationId },
    fetch: nodeFetch,
  }).pipe(
    Layer.provide(Layer.mergeAll(catalog, layerStaticToken(await kiloToken()), layerBackoff()))
  )
);

const program = Effect.gen(function* () {
  const session = yield* openSession({ system, model, effort: 'medium' });
  const one = yield* ask(session, first);
  const two = yield* ask(session, second);
  return { one, two, history: yield* session.history };
});

const result = await Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));

const turns = [...result.history];
const reasoningOf = (turn: Turn | undefined) =>
  turn?.parts.filter(part => part.kind === 'reasoning') ?? [];
const stored = reasoningOf(turns[1]);
const signature = stored[0]?.signature;

console.log('model         ', model);
console.log('first answer  ', JSON.stringify(result.one.said.slice(0, 60)));
console.log('first thinking', result.one.thought.length, 'characters');
console.log('reasoning part', stored.length, 'stored');
console.log(
  'signature     ',
  signature === undefined ? 'none' : `${String(signature.length)} characters`
);
console.log('second answer ', JSON.stringify(result.two.said.slice(0, 60)));
console.log('second usage  ', result.two.usage);

const failures: string[] = [];

if (result.one.thought.length === 0 && signature === undefined) {
  failures.push(
    'the model produced no thinking at all, so this run proves nothing; pick a model that ' +
      'thinks, or raise the effort'
  );
}
if (stored.length !== 1) {
  failures.push(`the answer kept ${String(stored.length)} reasoning parts, and it must keep one`);
}
if (signature === undefined) {
  failures.push(
    'the stored thinking carries no signature, so it can never be replayed and the provider ' +
      'would refuse it'
  );
}
if (result.two.said.length === 0) {
  failures.push('the second call carried the thinking back and produced no answer');
}

assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
console.log('\nPASS: the provider took its own thinking back and answered on top of it.');
