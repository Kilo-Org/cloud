import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mocks.getItemAsync.mockResolvedValue('org-9');

    await expect(getSelectedOrganizationId()).resolves.toBe('org-9');
    // The shared helper omits the options slot when the caller passes none.
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
  });

  it('reads the active user from its storage key', async () => {
    mocks.getItemAsync.mockResolvedValue('u1');

    await expect(getActiveUserId()).resolves.toBe('u1');
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY);
  });

  it.each([
    ['organization', getSelectedOrganizationId, ORGANIZATION_STORAGE_KEY],
    ['user', getActiveUserId, ACTIVE_USER_ID_KEY],
  ] as const)('resolves the %s hint to null when the key is absent', async (_label, read, key) => {
    mocks.getItemAsync.mockResolvedValue(null);

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
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : 'org-9'
    );

    await expect(readSignedInScope(keychain)).resolves.toEqual({
      status: 'known',
      userId: 'u1',
      organizationId: 'org-9',
    });
  });

  it('keeps a personal scope once the user id answers', async () => {
    setProtectedDataAvailable(false);
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : null
    );

    await expect(readSignedInScope(keychain)).resolves.toEqual({
      status: 'known',
      userId: 'u1',
      organizationId: null,
    });
  });

  it('reads an unanswered user id before the first unlock as unavailable, never signed out', async () => {
    setProtectedDataAvailable(false);
    mocks.getItemAsync.mockResolvedValue(null);

    await expect(readSignedInScope(keychain)).resolves.toEqual({ status: 'unavailable' });
    // The hint reader folds the same answer to null, which drops the work
    // instead of retiring the scope.
    await expect(getActiveUserId()).resolves.toBeNull();
  });

  it('still reads a signed-out device as absent while unlocked', async () => {
    mocks.getItemAsync.mockResolvedValue(null);

    await expect(readSignedInScope(keychain)).resolves.toEqual({ status: 'absent' });
  });
});
