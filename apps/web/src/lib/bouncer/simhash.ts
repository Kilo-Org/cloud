import 'server-only';

/**
 * A 64-bit SimHash of a text, as 16 hex characters. Near-identical texts get hashes that differ in
 * few bits, so bouncer can count repeated prompts without seeing their text.
 *
 * Features are word 3-grams of the lowercased text (single words for shorter texts). Each feature
 * gets a 64-bit hash from two 32-bit FNV-1a passes with different seeds, and each hash bit votes +1
 * or -1. Only the first `MAX_CHARS` characters count, so the cost is bounded on the gateway path.
 * The arithmetic stays in 32-bit integers: no BigInt on the hot path.
 */

const MAX_CHARS = 4_096;
const SHINGLE = 3;
const FNV_PRIME = 0x01000193;
const SEED_HIGH = 0x811c9dc5;
const SEED_LOW = 0x050c5d1f;

function fnv1a32(text: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function vote(votes: Int32Array, offset: number, word: number): void {
  for (let bit = 0; bit < 32; bit++) {
    votes[offset + bit] += (word >>> bit) & 1 ? 1 : -1;
  }
}

function toHex(votes: Int32Array, offset: number): string {
  let word = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (votes[offset + bit] > 0) word |= 1 << bit;
  }
  return (word >>> 0).toString(16).padStart(8, '0');
}

/** Returns `null` for a text with no words: an empty prompt carries no signal. */
export function simHash64(text: string): string | null {
  const words = text
    .slice(0, MAX_CHARS)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const size = Math.min(SHINGLE, words.length);
  const votes = new Int32Array(64);
  for (let start = 0; start + size <= words.length; start++) {
    const feature = words.slice(start, start + size).join(' ');
    vote(votes, 0, fnv1a32(feature, SEED_HIGH));
    vote(votes, 32, fnv1a32(feature, SEED_LOW));
  }
  return toHex(votes, 0) + toHex(votes, 32);
}
