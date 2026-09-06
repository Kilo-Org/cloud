import { Effect, Layer } from 'effect';
import { TokenSource } from '../../core/token.js';

/**
 * One token for the life of the process. Correct for a short run and for a
 * token that outlives it; wrong for a long-lived session, which wants a plugin
 * that can refresh.
 */
const layerStaticToken = (token: string): Layer.Layer<TokenSource> =>
  Layer.succeed(TokenSource, { get: () => Effect.succeed(token) });

export { layerStaticToken };
