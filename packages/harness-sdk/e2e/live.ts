import assert from 'node:assert/strict';
import { Effect, Stream } from 'effect';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import type { ModelUsage } from '../src/core/model.js';
import { hitRatio } from '../src/core/usage.js';
import { cachedSystem as system, kilo } from './setup.js';

const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

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

const program = Effect.gen(function* () {
  const session = yield* openSession({ system, model, maxTokens: 32 });
  const first = yield* ask(session, 'Answer with the word: one');
  const second = yield* ask(session, 'Answer with the word: two');
  return { id: session.id, first, second, total: yield* session.usage };
});

const layers = kilo();

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
