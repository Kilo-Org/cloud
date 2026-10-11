import { Effect } from 'effect';
import type { EntropySourceService } from './entropy.js';

/**
 * Makes an identifier of the form `{prefix}_{ulid}`.
 *
 * The ULID is built here rather than taken from the `ulid` package. That
 * package resolves to a build that imports `node:crypto` under the `node`
 * export condition, and to one that detects a global `crypto` at module scope
 * otherwise — so importing it either drags a runtime into the core or throws
 * on a runtime that has no global source yet. Both break a package that must
 * run anywhere. The encoding below is about forty lines of arithmetic with no
 * platform in it; the randomness comes from the `EntropySource` plugin and the
 * time from Effect's `Clock`.
 *
 * The ordering is deliberately not pluggable. An identifier must sort by the
 * order it was made in, because a store rebuilds the prompt prefix in that
 * order and a prefix in the wrong order misses the model cache. A plugin
 * returning a random identifier would typecheck, pass every test, and break
 * that one reload later.
 */

/** Crockford base 32, least ambiguous first. This is the ULID alphabet. */
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const base = 32;
const timeLength = 10;
const randomLength = 16;

const digit = (value: number): string => alphabet[value] ?? '0';

const encodeTime = (milliseconds: number): string => {
  let left = milliseconds;
  let encoded = '';
  for (let index = 0; index < timeLength; index += 1) {
    encoded = digit(left % base) + encoded;
    left = Math.floor(left / base);
  }
  return encoded;
};

/** 256 is a whole number of 32s, so a byte modulo the base stays uniform. */
const draw = (entropy: EntropySourceService): number[] => {
  const bytes = entropy.bytes(randomLength);
  const digits: number[] = [];
  for (let index = 0; index < randomLength; index += 1) {
    digits.push((bytes[index] ?? 0) % base);
  }
  return digits;
};

/** Adds one to the random part, carrying left. False when all 80 bits are set. */
const bump = (digits: number[]): boolean => {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const value = digits[index] ?? 0;
    if (value < base - 1) {
      digits[index] = value + 1;
      return true;
    }
    digits[index] = 0;
  }
  return false;
};

/**
 * One module means one monotonic sequence. Two sequences can hand out the same
 * millisecond twice, which is a flake that only shows up under load.
 */
const sequence = { time: -1, digits: [] as number[] };

const refill = (entropy: EntropySourceService): void => {
  sequence.digits = draw(entropy);
};

const nextUlid = (entropy: EntropySourceService, now: number): string => {
  if (now > sequence.time) {
    sequence.time = now;
    refill(entropy);
  } else if (!bump(sequence.digits)) {
    /* Eighty bits used inside one millisecond. Take the next millisecond
       rather than hand out an identifier that sorts before the last one. */
    sequence.time += 1;
    refill(entropy);
  }
  return encodeTime(sequence.time) + sequence.digits.map(digit).join('');
};

const makeId = (entropy: EntropySourceService, prefix: string): Effect.Effect<string> =>
  Effect.clockWith(clock =>
    Effect.map(clock.currentTimeMillis, now => `${prefix}_${nextUlid(entropy, now)}`)
  );

export { makeId };
