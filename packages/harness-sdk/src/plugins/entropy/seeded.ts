import { Layer } from 'effect';
import { EntropySource, type EntropySourceService } from '../../core/entropy.js';

/**
 * Randomness from a seed, so a run repeats. This is the second implementation
 * that earns `EntropySource` its place as a plugin point: it gives a test the
 * same identifiers every time, and it gives a runtime with no `crypto` a way
 * to run at all.
 *
 * It is not for anything that must be unguessable. Identifiers are not
 * secrets here — they name a turn, and the ordering is what matters — but do
 * not reach for this plugin outside a test or a replay.
 */
const modulus = 4_294_967_296;
const multiplier = 1_664_525;
const increment = 1_013_904_223;

const seededEntropy = (seed: number): EntropySourceService => {
  /* A linear congruential generator. Every product stays under 2^53, so it is
     exact in a double and needs no bit twiddling to stay in range. */
  const state = { value: Math.abs(Math.trunc(seed)) % modulus };
  const next = (): number => {
    state.value = (state.value * multiplier + increment) % modulus;
    // The low bits of an LCG cycle quickly; the high ones do not.
    return Math.floor(state.value / 65_536) % 256;
  };
  return { bytes: count => Uint8Array.from({ length: count }, next) };
};

const layerSeededEntropy = (seed: number): Layer.Layer<EntropySource> =>
  Layer.sync(EntropySource, () => seededEntropy(seed));

export { layerSeededEntropy, seededEntropy };
