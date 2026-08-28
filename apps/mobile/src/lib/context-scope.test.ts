import { beforeEach, describe, expect, it } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  contextScope,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  parseSelectedContext,
  selectedContextStorageKey,
  serializeSelectedContext,
} from './context-scope';

beforeEach(() => {
  setSignOutActive(false);
  beginAuthenticatedOwner();
});

describe('authenticated ownership', () => {
  it('rejects late identity proof after a direct account replacement', () => {
    const first = getAuthenticatedOwner();
    bumpAuthEpoch();
    const replacement = beginAuthenticatedOwner();
    expect(confirmAuthenticatedOwner(first, 'account-a')).toBe(false);
    expect(confirmAuthenticatedOwner(replacement, 'account-b')).toBe(true);
    expect(getAuthenticatedOwner().userId).toBe('account-b');
    expect(first.userId).toBeNull();
  });

  it('revokes old authority before credentials change, even before the epoch bump', () => {
    confirmAuthenticatedOwner(getAuthenticatedOwner(), 'account-a');
    const old = getAuthenticatedOwner();
    beginAuthenticatedOwner();
    expect(isAuthenticatedOwner(old)).toBe(false);
    expect(getAuthenticatedOwner().userId).toBeNull();
  });

  it('does not replace a proved identity with another user in the same generation', () => {
    const credential = getAuthenticatedOwner();
    confirmAuthenticatedOwner(credential, 'account-a');
    expect(confirmAuthenticatedOwner(credential, 'account-b')).toBe(false);
    expect(getAuthenticatedOwner().userId).toBe('account-a');
  });
});

describe('selected context records', () => {
  it.each(['oauth/a:b', 'a/b', 'a_b', 'a.b', 'a\u0000b', '用户', 'personal'])(
    'round-trips arbitrary owner %s without mixing storage keys',
    userId => {
      const key = selectedContextStorageKey(userId);
      expect(key).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(key).not.toBe(selectedContextStorageKey(`${userId}:other`));
      const bytes = serializeSelectedContext(userId, contextScope('personal'));
      expect(parseSelectedContext(bytes, userId)).toEqual({
        status: 'present',
        context: { kind: 'organization', organizationId: 'personal' },
      });
      expect(parseSelectedContext(bytes, `${userId}:other`)).toEqual({ status: 'owner-mismatch' });
    }
  );

  it('distinguishes saved Personal from an absent record', () => {
    expect(parseSelectedContext(serializeSelectedContext('u', contextScope(null)), 'u')).toEqual({
      status: 'present',
      context: { kind: 'personal' },
    });
    expect(parseSelectedContext(null, 'u')).toEqual({ status: 'absent' });
  });

  it.each([
    'org-id',
    '{',
    'null',
    '{}',
    '{"version":2,"userId":"u","context":{"kind":"personal"}}',
    '{"version":1,"userId":"u","context":{"kind":"organization","organizationId":""}}',
    '{"version":1,"userId":"u","context":{"kind":"personal","organizationId":"org"}}',
  ])('preserves malformed/legacy input instead of admitting Personal: %s', bytes => {
    expect(parseSelectedContext(bytes, 'u')).toEqual({ status: 'malformed' });
  });
});
