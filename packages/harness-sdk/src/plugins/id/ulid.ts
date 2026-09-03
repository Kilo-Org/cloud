import { Effect, Layer } from 'effect';
import { monotonicFactory } from 'ulid';
import { IdGenerator } from '../../core/id.js';

/**
 * The core identifier plugin. One layer holds one monotonic sequence, so build
 * the layer once and share it.
 */
const layerUlid: Layer.Layer<IdGenerator> = Layer.sync(IdGenerator, () => {
  const nextUlid = monotonicFactory();
  return { generate: prefix => Effect.sync(() => `${prefix}_${nextUlid()}`) };
});

export { layerUlid };
