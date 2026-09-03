import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { makeId } from './id.js';

const entropy = seededEntropy(7);

const many = (count: number): readonly string[] =>
  Effect.runSync(Effect.all(Array.from({ length: count }, () => makeId(entropy, 'trn'))));

it('sorts by the order it made them, which is what the prompt prefix relies on', () => {
  const ids = many(5000);
  expect([...ids].toSorted()).toEqual(ids);
});

it('never repeats an identifier', () => {
  const ids = many(5000);
  expect(new Set(ids).size).toBe(ids.length);
});

it('encodes the time in the leading ten characters', () => {
  const [id] = many(1);
  const time = id?.slice('trn_'.length, 'trn_'.length + 10) ?? '';
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const decoded = { value: 0 };
  for (let index = 0; index < time.length; index += 1) {
    decoded.value = decoded.value * 32 + alphabet.indexOf(time.charAt(index));
  }
  expect(Math.abs(decoded.value - Date.now())).toBeLessThan(1000);
});

it('carries into the next millisecond when the random part is exhausted', () => {
  /* An entropy source pinned to the top of the range: every draw is 31, so the
     next identifier in the same millisecond has nowhere to carry to. */
  const exhausted = { bytes: (count: number) => new Uint8Array(count).fill(255) };
  const ids = Effect.runSync(
    Effect.all(Array.from({ length: 3 }, () => makeId(exhausted, 'trn')))
  );
  expect([...ids].toSorted()).toEqual(ids);
  expect(new Set(ids).size).toBe(3);
});
