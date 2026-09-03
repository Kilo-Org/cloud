import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, Stream } from 'effect';
import { layerTableCatalog } from '../plugins/catalog/table.js';
import { layerSeededEntropy } from '../plugins/entropy/seeded.js';
import { fakeModel } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import { layerNodeStore } from '../plugins/store/node.js';
import type { ModelRequest } from './model.js';
import type { ResumeContext } from './resume.js';
import type { SessionHandle } from './wiring.js';

/**
 * What the continue and clone tests share.
 *
 * They run against the real SQLite store rather than a double, because what is
 * under test is whether a session survives being written down and read back. A
 * double would only prove that the double remembers.
 */

const options = { system: 'the system prompt', model: 'claude-opus-5', maxTokens: 1024 };

interface Bench {
  /** Runs one program against the same database, with the layers built afresh. */
  readonly run: <A, E>(
    use: Effect.Effect<A, E, ResumeContext>
  ) => Promise<{ readonly value: A; readonly calls: readonly ModelRequest[] }>;
}

/**
 * One database, many sessions. Each run builds its own layers, which is what a
 * second start of an application does.
 */
const bench = (): Bench => {
  const database = new DatabaseSync(':memory:');
  return {
    run: use => {
      const model = fakeModel([{ deltas: ['an answer'] }]);
      const layers = Layer.mergeAll(
        layerAssembler,
        layerTableCatalog({}, { apiKinds: ['messages'] }),
        layerSeededEntropy(1),
        model.layer,
        layerNodeStore(database)
      );
      return Effect.runPromise(Effect.scoped(Effect.provide(use, layers))).then(value => ({
        value,
        calls: model.calls,
      }));
    },
  };
};

/** Asks one question and keeps nothing, so a test can read what was sent. */
const asked = (session: SessionHandle, text: string): Effect.Effect<void, unknown> =>
  Stream.runDrain(session.ask(text));

/** What the model was sent, as plain text, so two prompts compare byte for byte. */
const prompted = (request: ModelRequest | undefined): string =>
  JSON.stringify(request?.prompt ?? {});

export type { Bench };
export { asked, bench, options, prompted };
