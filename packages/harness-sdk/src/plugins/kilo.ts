import { Layer } from 'effect';
import type {
  EntropyError,
  EntropySource,
  ModelCatalog,
  ModelClient,
  ModelFacts,
  PromptAssembler,
} from '../core/index.js';
import { layerTableCatalog } from './catalog/table.js';
import { layerWebCrypto } from './entropy/web-crypto.js';
import { layerKiloGateway, type KiloGatewayConfig } from './gateway/index.js';
import { layerAssembler } from './prompt/default.js';
import { layerBackoff } from './retry/backoff.js';
import { layerStaticToken } from './token/static.js';

/**
 * What a session needs, in one call.
 *
 * The pieces are still plugins and every one of them can be wired by hand.
 * This is the wiring almost every caller writes, so the package writes it: the
 * five layers, in the one order that works, with the catalog shared rather
 * than nested. A caller who needs a different plugin — a token that refreshes,
 * a catalog that asks the gateway, entropy from somewhere other than the
 * global `crypto` — composes the layers themselves instead.
 */
interface KiloSetup extends KiloGatewayConfig {
  /** One token for the life of the process. */
  readonly token: string;
  /** What each model can do. A model the table does not name uses `fallback`. */
  readonly models?: Readonly<Record<string, ModelFacts>>;
  /**
   * What to assume about a model the table does not name. By default, that it
   * speaks all three shapes, which the gateway's relayed models do — the best
   * one a model actually speaks is picked from this list, so naming all three
   * costs nothing and naming none would refuse every model.
   *
   * It says nothing about a context window, so a session wired this way never
   * compacts. A caller who wants compaction names the window here, or writes
   * the model into `models`.
   */
  readonly fallback?: ModelFacts;
  /** How many times a failed call is tried again. */
  readonly retries?: number;
}

/**
 * Everything `openSession` asks for, apart from the scope the caller opens.
 *
 * The error is the web-crypto source's: a runtime with no global `crypto`
 * fails when the layer is built, which is where a caller can still choose a
 * different source.
 */
type KiloLayer = Layer.Layer<
  PromptAssembler | EntropySource | ModelCatalog | ModelClient,
  EntropyError
>;

/**
 * The catalog is built once and given to both the session and the gateway.
 * Building it twice typechecks and answers the same, but the gateway then
 * holds a different instance from the one the session reads, which is a trap
 * worth closing here rather than documenting.
 */
/** Best first, which is how `wireFor` reads the list. */
const everyShape: ModelFacts = { apiKinds: ['messages', 'responses', 'chat_completions'] };

const layerKilo = (setup: KiloSetup): KiloLayer => {
  const catalog = layerTableCatalog(setup.models ?? {}, setup.fallback ?? everyShape);
  return Layer.mergeAll(
    layerAssembler,
    layerWebCrypto,
    catalog,
    layerKiloGateway(setup).pipe(
      Layer.provide(
        Layer.mergeAll(catalog, layerStaticToken(setup.token), layerBackoff(setup.retries))
      )
    )
  );
};

export type { KiloSetup };
export { layerKilo };
