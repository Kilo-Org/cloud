import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBlockedAccountExplanation,
  isBlockedAccountActive,
  setBlockedAccountExplanation,
  subscribeBlockedAccount,
} from '@/lib/auth/blocked-account-state';

describe('blocked account state', () => {
  beforeEach(() => {
    setBlockedAccountExplanation(null);
  });

  it('starts cleared', () => {
    expect(getBlockedAccountExplanation()).toBeNull();
    expect(isBlockedAccountActive()).toBe(false);
  });

  it('sets a reason and notifies subscribers', () => {
    const listener = vi.fn<() => void>();
    subscribeBlockedAccount(listener);

    setBlockedAccountExplanation('account_blocked');

    expect(getBlockedAccountExplanation()).toBe('account_blocked');
    expect(isBlockedAccountActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the domain refusal apart from the account block', () => {
    setBlockedAccountExplanation('email_domain_blocked');

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');
    expect(isBlockedAccountActive()).toBe(true);
  });

  it('notifies once per change, not on a repeated value', () => {
    const listener = vi.fn<() => void>();
    subscribeBlockedAccount(listener);

    setBlockedAccountExplanation('account_blocked');
    setBlockedAccountExplanation('account_blocked');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies on a change of reason', () => {
    const listener = vi.fn<() => void>();
    setBlockedAccountExplanation('account_blocked');
    subscribeBlockedAccount(listener);

    setBlockedAccountExplanation('email_domain_blocked');

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears the reason and notifies subscribers', () => {
    const listener = vi.fn<() => void>();
    setBlockedAccountExplanation('account_blocked');
    subscribeBlockedAccount(listener);

    setBlockedAccountExplanation(null);

    expect(getBlockedAccountExplanation()).toBeNull();
    expect(isBlockedAccountActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies every subscriber', () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    subscribeBlockedAccount(first);
    subscribeBlockedAccount(second);

    setBlockedAccountExplanation('account_blocked');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeBlockedAccount(listener);
    unsubscribe();

    setBlockedAccountExplanation('account_blocked');

    expect(listener).not.toHaveBeenCalled();
  });
});
