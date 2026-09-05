import { Effect, Stream } from 'effect';
import { openSession } from '../src/core/run.js';
import type { SessionHandle } from '../src/core/handle.js';
import type { ModelUsage } from '../src/core/model.js';
import { hitRatio } from '../src/core/usage.js';
import { cachedSystem as system, kilo, models } from './setup.js';
import { fail, passed, wrongIf } from './report.js';

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

const program = (model: string) =>
  Effect.gen(function* () {
    const session = yield* openSession({ system, model, maxTokens: 256 });
    const first = yield* ask(session, 'Answer with the word: one');
    const second = yield* ask(session, 'Answer with the word: two');
    return { id: session.id, first, second, total: yield* session.usage };
  });

const layers = kilo();

for (const model of models) {
  const result = await Effect.runPromise(Effect.scoped(Effect.provide(program(model), layers)));

  console.log('session   ', result.id);
  console.log('model     ', model);
  console.log('first     ', JSON.stringify(result.first.said), result.first.usage);
  console.log('second    ', JSON.stringify(result.second.said), result.second.usage);
  console.log('cumulative', result.total, 'hit ratio', hitRatio(result.total).toFixed(4));

  wrongIf(result.first.said.length === 0, `${model}: the first answer carried no text`);
  wrongIf(result.second.said.length === 0, `${model}: the second answer carried no text`);

  const second = result.second.usage;
  if (second === undefined) {
    fail(`${model}: the second answer carried no token counts`);
    continue;
  }
  wrongIf(second.cacheReadTokens === 0, `${model}: the second call read nothing from the cache`);
  /* Half, not all. Haiku reads back over 0.99 of the prefix and glm reads 0.61
     of the same conversation, because a provider caches at a granularity of its
     own. What the run is defending is that the prefix was read rather than
     built again, and a floor every provider clears still says that. */
  wrongIf(
    hitRatio(second) <= 0.5,
    `${model}: the cache hit ratio was ${hitRatio(second).toFixed(4)}, which is not above 0.5`
  );
}

passed('every model read the prefix back from the cache');
