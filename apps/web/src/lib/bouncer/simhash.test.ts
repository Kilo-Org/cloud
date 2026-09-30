import { describe, expect, it } from '@jest/globals';

import { simHash64 } from '@/lib/bouncer/simhash';

/** Hamming distance between two 16-hex hashes. */
function distance(a: string, b: string): number {
  let bits = 0;
  for (let index = 0; index < 16; index += 8) {
    let diff =
      (parseInt(a.slice(index, index + 8), 16) ^ parseInt(b.slice(index, index + 8), 16)) >>> 0;
    while (diff) {
      bits += diff & 1;
      diff >>>= 1;
    }
  }
  return bits;
}

const PROMPT =
  'Translate the following paragraph into French and keep the technical terms in English. ' +
  'The service validates every request, stores the verdict, and logs the decision for review.';

describe('simHash64', () => {
  it('returns 16 lowercase hex characters, as bouncer requires', () => {
    expect(simHash64(PROMPT)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores case and punctuation, so trivially reformatted prompts collide', () => {
    expect(simHash64(PROMPT.toUpperCase().replaceAll('.', '!'))).toBe(simHash64(PROMPT));
  });

  it('keeps a one-word edit close and an unrelated prompt far', () => {
    const base = simHash64(PROMPT) ?? '';
    const edited = simHash64(PROMPT.replace('French', 'German')) ?? '';
    const unrelated =
      simHash64(
        'Write a haiku about autumn rain falling on an old wooden bridge near the mountain village.'
      ) ?? '';
    expect(distance(base, edited)).toBeLessThan(16);
    expect(distance(base, unrelated)).toBeGreaterThan(distance(base, edited));
  });

  it('returns null for a prompt with no words', () => {
    expect(simHash64('')).toBeNull();
    expect(simHash64('  ?! ')).toBeNull();
  });
});
