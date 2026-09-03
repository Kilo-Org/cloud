import { Layer } from 'effect';
import { TokenCeiling } from '../../core/ceiling.js';

/**
 * The same ceiling for every model. 4096 is high enough that a reasoning model
 * still has room to write after it thinks: at 64 tokens, four of the ten most
 * used models on OpenRouter answered nothing at all.
 */
const layerFixedCeiling = (tokens = 4096): Layer.Layer<TokenCeiling> =>
  Layer.succeed(TokenCeiling, { of: () => tokens });

export { layerFixedCeiling };
