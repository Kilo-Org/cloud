import { describe, expect, it } from 'vitest';

import { splitInlineCode } from '@/lib/inline-code';

describe('splitInlineCode', () => {
  it('splits the composer hint into prose and its two commands', () => {
    expect(
      splitInlineCode(
        'Run `kilo remote` on your computer, or `/remote` in a running CLI session, to control a local kilo process.'
      )
    ).toEqual([
      { value: 'Run ', code: false },
      { value: 'kilo remote', code: true },
      { value: ' on your computer, or ', code: false },
      { value: '/remote', code: true },
      { value: ' in a running CLI session, to control a local kilo process.', code: false },
    ]);
  });

  it('returns the copy unchanged when it carries no marker', () => {
    expect(splitInlineCode('Run kilo remote on your computer.')).toEqual([
      { value: 'Run kilo remote on your computer.', code: false },
    ]);
  });

  it('keeps an empty pair as literal copy instead of an empty code run', () => {
    const segments = splitInlineCode('a `` b');

    expect(segments.every(segment => !segment.code)).toBe(true);
    expect(segments.map(segment => segment.value).join('')).toBe('a `` b');
  });

  it('keeps an unpaired marker in the copy so it never swallows the rest of the line', () => {
    expect(splitInlineCode('run `kilo remote now')).toEqual([
      { value: 'run `kilo remote now', code: false },
    ]);
  });

  it('keeps a trailing unpaired marker after a paired span', () => {
    expect(splitInlineCode('run `kilo remote` then `')).toEqual([
      { value: 'run ', code: false },
      { value: 'kilo remote', code: true },
      { value: ' then `', code: false },
    ]);
  });

  it('handles a run at either end of the string', () => {
    expect(splitInlineCode('`a` middle `b`')).toEqual([
      { value: 'a', code: true },
      { value: ' middle ', code: false },
      { value: 'b', code: true },
    ]);
  });

  it('returns no runs for empty copy', () => {
    expect(splitInlineCode('')).toEqual([]);
  });
});
