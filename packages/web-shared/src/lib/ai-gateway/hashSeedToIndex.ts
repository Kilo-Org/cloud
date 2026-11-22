import * as crypto from 'crypto';

/**
 * Maps a seed string deterministically into `[0, max)`, so the same seed and bound always pick
 * the same index. The modulo biases low indices, so this is a stable selection, not uniform
 * randomness. `max` must be a positive integer.
 */
export function hashSeedToIndex(randomSeed: string, max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`hashSeedToIndex: max must be a positive integer, received ${max}`);
  }
  return crypto.createHash('sha256').update(randomSeed).digest().readUInt32BE(0) % max;
}
