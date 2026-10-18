import { Effect, Layer } from 'effect';
import { CatalogError, ModelCatalog, type ModelFacts } from '../../core/catalog.js';

/**
 * A catalog the caller writes down. It costs no request and never surprises,
 * and it goes stale the day a provider adds a shape.
 *
 * `fallback` answers for a model the table does not name. Without one an
 * unknown model fails, which is the honest answer when the table is meant to
 * be complete.
 */
const layerTableCatalog = (
  table: Readonly<Record<string, ModelFacts>>,
  fallback?: ModelFacts
): Layer.Layer<ModelCatalog> =>
  Layer.succeed(ModelCatalog, {
    facts: model => {
      const known = table[model] ?? fallback;
      return known === undefined
        ? Effect.fail(new CatalogError({ model, cause: 'the catalog does not name this model' }))
        : Effect.succeed(known);
    },
  });

export { layerTableCatalog };
