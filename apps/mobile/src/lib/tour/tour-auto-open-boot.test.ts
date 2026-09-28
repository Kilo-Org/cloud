import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// The launch-account binding is module state, so each case starts from a fresh
// module to model one cold boot.
describe('tour auto-open launch account binding', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('binds to the first account seen and keeps the same account', async () => {
    const { claimTourAutoOpenAttempt } = await import('./tour-auto-open-boot');

    expect(claimTourAutoOpenAttempt('launch-user')).toBe(true);
    // A later render or sign-in of the launch account still owns the attempt.
    expect(claimTourAutoOpenAttempt('launch-user')).toBe(true);
  });

  it('rejects a later account, so a warm switch cannot inherit the attempt', async () => {
    const { claimTourAutoOpenAttempt } = await import('./tour-auto-open-boot');

    expect(claimTourAutoOpenAttempt('launch-user')).toBe(true);
    expect(claimTourAutoOpenAttempt('other-user')).toBe(false);
    // A rejection must not rebind, or the next render could open for the
    // switched-in account.
    expect(claimTourAutoOpenAttempt('other-user')).toBe(false);
    expect(claimTourAutoOpenAttempt('launch-user')).toBe(true);
  });
});
