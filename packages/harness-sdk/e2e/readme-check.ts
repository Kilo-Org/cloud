/* The README's first example, with the package name resolved to this source
   tree. It is typechecked, never run: a snippet that does not compile is worse
   than no snippet. */
import { Effect, Layer, Stream } from 'effect';
import { openSession } from '../src/core/run.js';
import { layerKilo } from '../src/plugins/kilo.js';
import { continueSession, cloneSession } from '../src/core/resume.js';
import { hitRatio } from '../src/core/usage.js';
import { layerNodeStore } from '../src/plugins/store/node.js';
import { DatabaseSync } from 'node:sqlite';
import { nodeFetch } from './node-fetch.js';

const layers = layerKilo({
  baseUrl: 'https://app.kilo.ai',
  org: { kind: 'organization', id: 'org_...' },
  fetch: nodeFetch,
  token: '...',
  fallback: { apiKinds: ['messages'] },
});

const program = Effect.gen(function* () {
  const session = yield* openSession({
    system: 'You are terse.',
    model: 'anthropic/claude-haiku-4.5',
  });
  yield* Stream.runForEach(session.ask('Name three fruits.'), event =>
    Effect.sync(() => {
      if (event.kind === 'delta') {
        process.stdout.write(event.text);
      }
    })
  );
  yield* session.compact;
  console.log(hitRatio(yield* session.usage));
});

const store = layerNodeStore(new DatabaseSync('sessions.db'));
export const resumed = Effect.provide(
  Effect.gen(function* () {
    yield* continueSession('ses_1');
    yield* cloneSession('ses_1');
  }),
  Layer.mergeAll(layers, store)
);

export const run = (): Promise<void> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));

/* The tags the README's failure table names. `catchTag` rejects a tag the
   error union does not hold, so renaming one fails here rather than in a
   caller's editor. */
export const handled = Effect.gen(function* () {
  const session = yield* openSession({ system: 'sys', model: 'm' });
  return yield* Stream.runDrain(session.ask('hi')).pipe(
    Effect.catchTag('harness/ModelError', error => Effect.succeed(error.reason)),
    Effect.catchTag('harness/StoreError', error => Effect.succeed(error.operation)),
    Effect.catchTag('harness/SessionBusyError', error => Effect.succeed(error.sessionId))
  );
});

export const reopened = continueSession('ses_1').pipe(
  Effect.catchTag('harness/SessionNotFoundError', error => Effect.succeed(error.sessionId))
);
