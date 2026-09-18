import { describe, expect, it } from 'vitest';

import { isTourAutoOpenAttemptSpent, spendTourAutoOpenAttempt } from './tour-auto-open-boot';

describe('tour auto-open boot marker', () => {
  it('is unspent at process start', () => {
    expect(isTourAutoOpenAttemptSpent()).toBe(false);
  });

  it('is spent after the attempt is spent', () => {
    spendTourAutoOpenAttempt();
    expect(isTourAutoOpenAttemptSpent()).toBe(true);
  });

  it('stays spent after a second call, so a warm entry never re-arms it', () => {
    spendTourAutoOpenAttempt();
    spendTourAutoOpenAttempt();
    expect(isTourAutoOpenAttemptSpent()).toBe(true);
  });
});
