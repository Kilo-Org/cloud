import { Effect, Layer } from 'effect';
import { EntropyError, EntropySource, type EntropySourceService } from '../../core/entropy.js';

/**
 * The Web Crypto surface this plugin needs. It is declared here rather than
 * taken from the DOM library, so the package still compiles with `"types": []`.
 */
interface WebCrypto {
  readonly getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

/** What this plugin needs of the global object, and nothing more. */
interface CryptoHost {
  readonly crypto?: WebCrypto | undefined;
}

const host: CryptoHost = globalThis;

/**
 * Randomness from the global `crypto`, which Node 19 and later, Bun, Deno,
 * every browser and every worker runtime all provide. It is the default
 * because it is the one source that is the same everywhere it exists.
 *
 * A React Native release build has no global `crypto` until a polyfill is
 * installed, so this layer fails there rather than at the first identifier.
 * Install `react-native-get-random-values`, or supply another plugin.
 */
const layerWebCrypto: Layer.Layer<EntropySource, EntropyError> = Layer.effect(
  EntropySource,
  Effect.suspend(() => {
    const source = host.crypto;
    return source === undefined
      ? Effect.fail(
          new EntropyError({ cause: 'this runtime has no global crypto.getRandomValues' })
        )
      : Effect.succeed<EntropySourceService>({
          bytes: count => source.getRandomValues(new Uint8Array(count)),
        });
  })
);

export { layerWebCrypto };
