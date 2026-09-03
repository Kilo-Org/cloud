import { Chunk, Effect, Layer, Option } from 'effect';
import { layerTableCatalog } from '../plugins/catalog/table.js';
import type { ModelCatalog } from './catalog.js';
import { layerSeededEntropy } from '../plugins/entropy/seeded.js';
import { fakeModel, type FakeReply } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import type { SessionBusyError } from './ask.js';
import type { ModelError, ModelRequest } from './model.js';
import { openSession, type SessionHandle } from './run.js';
import { SessionStore, StoreError } from './storage.js';
import type { Turn } from './turn.js';

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
    append: (turn: Turn) => Effect.sync(() => void seen.push(`${turn.role}:${turn.content}`)),
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
    append: (turn: Turn) =>
      broken === 'append'
        ? refuse('append')
        : Effect.sync(() => void seen.push(`${turn.role}:${turn.content}`)),
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
): Promise<{ readonly value: A; readonly calls: readonly ModelRequest[] }> => {
  const model = fakeModel(replies);
  const layers = Layer.mergeAll(layerAssembler, silentCatalog, layerSeededEntropy(1), model.layer);
  const program = Effect.scoped(Effect.flatMap(openSession(options), use));
  return Effect.runPromise(
    Effect.provide(program, store === undefined ? layers : Layer.merge(layers, store))
  ).then(value => ({ value, calls: model.calls }));
};

const texts = (turns: Chunk.Chunk<Turn>): readonly string[] =>
  Chunk.toReadonlyArray(turns).map(turn => `${turn.role}:${turn.content}`);

export {
  brokenStore,
  catalogSaying,
  emptyCatalog,
  options,
  recordingStore,
  run,
  silentCatalog,
  texts,
};
