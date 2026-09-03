import { Context, Effect, Layer } from 'effect';
import { monotonicFactory } from 'ulid';

/**
 * Makes an identifier of the form `{prefix}_{ulid}`. The ULID is monotonic, so
 * two identifiers made in the same millisecond still sort by the order they
 * were made in.
 */
interface IdGeneratorService {
  readonly generate: (prefix: string) => Effect.Effect<string>;
}

class IdGenerator extends Context.Tag('harness/IdGenerator')<IdGenerator, IdGeneratorService>() {}

/** The core plugin. Uses the `ulid` package. */
const layerUlid: Layer.Layer<IdGenerator> = Layer.sync(IdGenerator, () => {
  const nextUlid = monotonicFactory();
  return { generate: prefix => Effect.sync(() => `${prefix}_${nextUlid()}`) };
});

export type { IdGeneratorService };
export { IdGenerator, layerUlid };
