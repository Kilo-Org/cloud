import { Effect, Layer, Option } from 'effect';
import { layerTableCatalog } from '../plugins/catalog/table.js';
import type { ModelCatalog } from './catalog.js';
import { layerSeededEntropy } from '../plugins/entropy/seeded.js';
import { fakeModel, type FakeReply } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import type { SessionBusyError } from './ask.js';
import type { ModelError, ModelRequest } from './model.js';
import { openSession } from './run.js';
import type { SessionHandle, SessionOptions } from './wiring.js';
import { SessionStore, StoreError } from './storage.js';
import { textOf, type Turn } from './turn.js';

/**
 * What the session tests share. It lives outside a `*.test.ts` file so three
 * test files can use it without repeating it, and it is excluded from `dist/`
 * along with the other test doubles.
 */

const options = { system: 'sys', model: 'claude-opus-5', maxTokens: 1024 };

/** A catalog that names no output limit, so the package falls back to 4096. */
const silentCatalog = layerTableCatalog({}, { apiKinds: ['messages'] });

/** A catalog that does name one, which is what a caller who names none gets. */
const catalogSaying = (maxOutputTokens: number): Layer.Layer<ModelCatalog> =>
  layerTableCatalog({}, { apiKinds: ['messages'], maxOutputTokens });

/** A catalog that answers for nothing, which is what an empty table does. */
const emptyCatalog = layerTableCatalog({});

const recordingStore = (): {
  readonly seen: string[];
  readonly layer: Layer.Layer<SessionStore>;
} => {
  const seen: string[] = [];
  const layer = Layer.succeed(SessionStore, {
    create: () => Effect.void,
    read: () => Effect.succeed(Option.none()),
    append: (written: readonly Turn[]) =>
      Effect.sync(() => {
        for (const turn of written) {
          seen.push(`${turn.role}:${textOf(turn)}`);
        }
      }),
    load: () => Effect.succeed([] as readonly Turn[]),
    flush: () => Effect.sync(() => void seen.push('flush')),
  });
  return { seen, layer };
};

/**
 * A store that fails the operation named, and records what it was told about.
 * `seen` is what the store actually holds; the session's own history is what
 * it thinks the store holds. The two diverging is the defect under test.
 */
const brokenStore = (
  broken: 'append' | 'flush'
): { readonly seen: string[]; readonly layer: Layer.Layer<SessionStore> } => {
  const seen: string[] = [];
  const refuse = (operation: 'append' | 'flush') =>
    Effect.fail(new StoreError({ operation, cause: 'the disk is full' }));
  const layer = Layer.succeed(SessionStore, {
    create: () => Effect.void,
    read: () => Effect.succeed(Option.none()),
    append: (written: readonly Turn[]) =>
      broken === 'append'
        ? refuse('append')
        : Effect.sync(() => {
            for (const turn of written) {
              seen.push(`${turn.role}:${textOf(turn)}`);
            }
          }),
    load: () => Effect.succeed([] as readonly Turn[]),
    flush: () =>
      broken === 'flush' ? refuse('flush') : Effect.sync(() => void seen.push('flush')),
  });
  return { seen, layer };
};

const run = <A>(
  replies: readonly FakeReply[],
  use: (session: SessionHandle) => Effect.Effect<A, ModelError | StoreError | SessionBusyError>,
  store?: Layer.Layer<SessionStore>
): Promise<{ readonly value: A; readonly calls: readonly ModelRequest[] }> =>
  runWith({ replies, use, ...(store === undefined ? {} : { store }) });

/** What one session test needs. `run` is this with the usual catalog and options. */
interface Setup<A> {
  readonly replies: readonly FakeReply[];
  readonly use: (
    session: SessionHandle
  ) => Effect.Effect<A, ModelError | StoreError | SessionBusyError>;
  readonly store?: Layer.Layer<SessionStore>;
  readonly catalog?: Layer.Layer<ModelCatalog>;
  readonly options?: SessionOptions;
}

const runWith = <A>(
  setup: Setup<A>
): Promise<{ readonly value: A; readonly calls: readonly ModelRequest[] }> => {
  const model = fakeModel(setup.replies);
  const layers = Layer.mergeAll(
    layerAssembler,
    setup.catalog ?? silentCatalog,
    layerSeededEntropy(1),
    model.layer
  );
  const program = Effect.scoped(Effect.flatMap(openSession(setup.options ?? options), setup.use));
  return Effect.runPromise(
    Effect.provide(program, setup.store === undefined ? layers : Layer.merge(layers, setup.store))
  ).then(value => ({ value, calls: model.calls }));
};

/** A catalog that names a window, which is what makes a session compact itself. */
const catalogWindowed = (contextWindow: number): Layer.Layer<ModelCatalog> =>
  layerTableCatalog({}, { apiKinds: ['messages'], contextWindow });

const texts = (turns: readonly Turn[]): readonly string[] =>
  turns.map(turn => `${turn.role}:${textOf(turn)}`);

export type { Setup };
export {
  brokenStore,
  catalogSaying,
  catalogWindowed,
  emptyCatalog,
  options,
  recordingStore,
  run,
  runWith,
  silentCatalog,
  texts,
};
