import { beforeEach, describe, expect, it } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  subscribeAuthenticatedOwner,
} from './context-scope';

describe('authenticated ownership', () => {
  beforeEach(() => {
    setSignOutActive(false);
    bumpAuthEpoch();
    beginAuthenticatedOwner();
  });

  it('revokes the confirmed owner synchronously when replacement begins', () => {
    confirmAuthenticatedOwner(getAuthenticatedOwner(), 'user-a');
    const previous = getAuthenticatedOwner();
    const visibleOwners: (string | null)[] = [];
    const unsubscribe = subscribeAuthenticatedOwner(() => {
      visibleOwners.push(getAuthenticatedOwner().userId);
    });

    beginAuthenticatedOwner();

    expect(isAuthenticatedOwner(previous)).toBe(false);
    expect(visibleOwners).toEqual([null]);
    unsubscribe();
  });

  it('rejects a late confirmation even when replacement stays in the same epoch', () => {
    const previous = getAuthenticatedOwner();
    const current = beginAuthenticatedOwner();
    confirmAuthenticatedOwner(current, 'user-b');

    expect(confirmAuthenticatedOwner(previous, 'user-a')).toBe(false);
    expect(getAuthenticatedOwner().userId).toBe('user-b');
  });

  it('keeps repeated current confirmation stable and rejects conflicting identity', () => {
    const pending = getAuthenticatedOwner();
    confirmAuthenticatedOwner(pending, 'user-a');
    const confirmed = getAuthenticatedOwner();

    expect(confirmAuthenticatedOwner(pending, 'user-a')).toBe(true);
    expect(confirmAuthenticatedOwner(pending, 'user-b')).toBe(false);
    expect(getAuthenticatedOwner()).toBe(confirmed);
    expect(isAuthenticatedOwner(confirmed)).toBe(true);
  });

  it('rejects confirmation while sign-out closes admission before the epoch moves', () => {
    const pending = getAuthenticatedOwner();
    setSignOutActive(true);

    expect(confirmAuthenticatedOwner(pending, 'user-a')).toBe(false);
    expect(getAuthenticatedOwner().userId).toBeNull();
  });

  it('rejects a confirmation captured before the auth epoch moved', () => {
    const pending = getAuthenticatedOwner();
    bumpAuthEpoch();

    expect(confirmAuthenticatedOwner(pending, 'user-a')).toBe(false);
    expect(getAuthenticatedOwner().userId).toBeNull();
  });
});
