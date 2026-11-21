import { describe, expect, it } from 'vitest';

import { formatList } from '@/lib/format';

import { joinAccessibleName } from './accessible-name';

describe('joinAccessibleName', () => {
  it('drops absent parts and keeps the label alone', () => {
    expect(joinAccessibleName(['Email', null, undefined, ''])).toBe('Email');
  });

  it('joins two parts with punctuation', () => {
    expect(joinAccessibleName(['Lenient', 'Only serious problems'])).toBe(
      'Lenient, Only serious problems'
    );
  });

  it('joins three parts in the order given', () => {
    expect(joinAccessibleName(['Email', 'required', 'error: Enter a valid email'])).toBe(
      'Email, required, error: Enter a valid email'
    );
  });

  // "A und B" reads the second fact as a second offered item.
  it('never joins with the German list conjunction', () => {
    expect(joinAccessibleName(['A', 'B'])).toBe('A, B');
    expect(joinAccessibleName(['A', 'B'])).not.toBe(formatList(['A', 'B'], 'de'));
  });
});
