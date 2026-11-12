import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_STORE_CLASS_MARKER } from '@/lib/auth/secure-store-gated';
import { setProtectedDataAvailable } from '@/lib/protected-data';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import {
  _setScopeStoreForTests,
  getActiveUserId,
  getSelectedOrganizationId,
  readSignedInScope,
} from './scope';

const mocks = vi.hoisted(() => ({ getItemAsync: vi.fn() }));

// The store the hints are read through. Only the read is exercised here.
const keychain = { getItemAsync: mocks.getItemAsync };

/**
 * Answer the given items, with the class marker reading back the way an install
 * whose upgrade finished does. `upgraded: false` models the window before it, or
 * a closed keychain, where no `null` is trusted; a case that models a closed
 * keychain can also override the mock with a plain `null` for every key.
 */
function answers(
  values: Readonly<Record<string, string | null>> = {},
  { upgraded = true }: { upgraded?: boolean } = {}
): void {
  mocks.getItemAsync.mockImplementation((key: string) => {
    if (key === WIDGET_STORE_CLASS_MARKER.key) {
      return upgraded ? WIDGET_STORE_CLASS_MARKER.value : null;
    }
    return values[key] ?? null;
  });
}

beforeEach(() => {
  mocks.getItemAsync.mockReset();
  _setScopeStoreForTests(keychain);
});

afterEach(() => {
  _setScopeStoreForTests(null);
  setProtectedDataAvailable(true);
});

describe('glanceable scope reads', () => {
  it('reads the selected organization from its storage key', async () => {
    answers({ [ORGANIZATION_STORAGE_KEY]: 'org-9' });

    await expect(getSelectedOrganizationId()).resolves.toBe('org-9');
    // The shared helper omits the options slot when the caller passes none.
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
  });

  it('reads the active user from its storage key', async () => {
    answers({ [ACTIVE_USER_ID_KEY]: 'u1' });

    await expect(getActiveUserId()).resolves.toBe('u1');
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY);
  });

  it.each([
    ['organization', getSelectedOrganizationId, ORGANIZATION_STORAGE_KEY],
    ['user', getActiveUserId, ACTIVE_USER_ID_KEY],
  ] as const)('resolves the %s hint to null when the key is absent', async (_label, read, key) => {
    answers();

    await expect(read()).resolves.toBeNull();
    expect(mocks.getItemAsync).toHaveBeenCalledWith(key);
  });

  it.each([
    ['organization', getSelectedOrganizationId],
    ['user', getActiveUserId],
  ] as const)('resolves the %s hint to null when the read throws', async (_label, read) => {
    mocks.getItemAsync.mockRejectedValue(new Error('storage unavailable'));

    await expect(read()).resolves.toBeNull();
  });
});

describe('readSignedInScope', () => {
  it('reads both hints with the screen locked', async () => {
    setProtectedDataAvailable(false);
    answers({ [ACTIVE_USER_ID_KEY]: 'u1', [ORGANIZATION_STORAGE_KEY]: 'org-9' });

    await expect(readSignedInScope(keychain)).resolves.toEqual({
      status: 'known',
      userId: 'u1',
      organizationId: 'org-9',
    });
  });

  it('keeps a personal scope once the class upgrade has run', async () => {
    setProtectedDataAvailable(false);
    answers({ [ACTIVE_USER_ID_KEY]: 'u1' });

    await expect(readSignedInScope(keychain)).resolves.toEqual({
      status: 'known',
      userId: 'u1',
      organizationId: null,
    });
  });

  it('does not read a null organization id as the personal scope before the upgrade', async () => {
    // The user id answers, so the device is readable, but the organization item
    // may still carry the old class and answer null while locked: that is not
    // the personal scope, it is an unproven one.
    setProtectedDataAvailable(false);
    answers({ [ACTIVE_USER_ID_KEY]: 'u1' }, { upgraded: false });

    await expect(readSignedInScope(keychain)).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads an unanswered user id before the first unlock as unavailable, never signed out', async () => {
    setProtectedDataAvailable(false);
    // A closed keychain cannot answer the marker either, so the null proves nothing.
    mocks.getItemAsync.mockResolvedValue(null);

    await expect(readSignedInScope(keychain)).resolves.toEqual({ status: 'unavailable' });
    // The hint reader folds the same answer to null, which drops the work
    // instead of retiring the scope.
    await expect(getActiveUserId()).resolves.toBeNull();
  });

  it('reads a signed-out device as absent when the keychain answers', async () => {
    answers();

    await expect(readSignedInScope(keychain)).resolves.toEqual({ status: 'absent' });
  });
});
