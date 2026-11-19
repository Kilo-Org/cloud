import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isBlockedAccountActive,
  setBlockedAccountActive,
  subscribeBlockedAccount,
} from '@/lib/auth/blocked-account-state';

describe('blocked account state', () => {
  beforeEach(() => {
    setBlockedAccountActive(false);
  });

  it('starts cleared', () => {
    expect(isBlockedAccountActive()).toBe(false);
  });

  it('raises the flag and notifies subscribers', () => {
    const listener = vi.fn<() => void>();
    subscribeBlockedAccount(listener);

    setBlockedAccountActive(true);

    expect(isBlockedAccountActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies once per change, not on a repeated value', () => {
    const listener = vi.fn<() => void>();
    subscribeBlockedAccount(listener);

    setBlockedAccountActive(true);
    setBlockedAccountActive(true);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears the flag and notifies subscribers', () => {
    const listener = vi.fn<() => void>();
    setBlockedAccountActive(true);
    subscribeBlockedAccount(listener);

    setBlockedAccountActive(false);

    expect(isBlockedAccountActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeBlockedAccount(listener);
    unsubscribe();

    setBlockedAccountActive(true);

    expect(listener).not.toHaveBeenCalled();
  });
});
