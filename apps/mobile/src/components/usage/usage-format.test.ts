import { describe, expect, test } from 'vitest';

import { humanizeDimension } from './usage-format';

describe('humanizeDimension', () => {
  test('turns a slug into words', () => {
    expect(humanizeDimension('code-review', 'en')).toBe('Code Review');
    expect(humanizeDimension('smoke_mode', 'en')).toBe('Smoke Mode');
  });

  test('leaves an empty key alone', () => {
    expect(humanizeDimension('', 'en')).toBe('');
  });

  test("cases with the reader's language, not the runtime default", () => {
    // A Turkish lowercase i upper-cases to İ; a bare toUpperCase() would write
    // "Inspect" to a Turkish reader.
    expect(humanizeDimension('inspect-usage', 'tr')).toBe('İnspect Usage');
    expect(humanizeDimension('inspect-usage', 'en')).toBe('Inspect Usage');
  });
});
