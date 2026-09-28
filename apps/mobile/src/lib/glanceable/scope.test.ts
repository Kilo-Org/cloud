import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { getActiveUserId, getSelectedOrganizationId } from './scope';

const mocks = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
}));

describe('glanceable scope reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
