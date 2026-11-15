import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({ browser: { tabs: { create: vi.fn() } }, storage: {} }));

// eslint-disable-next-line import/first
import { pollDelayMs } from './use-device-sign-in';

describe('device sign-in poll backoff', () => {
  it('grows with consecutive failures and stops at the ceiling', () => {
    expect([0, 1, 2, 3, 4, 9].map(failures => pollDelayMs(failures))).toStrictEqual([
      3000, 6000, 12_000, 24_000, 30_000, 30_000,
    ]);
  });
});
