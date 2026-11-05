import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { getActiveUserId, getSelectedOrganizationId } from './scope';

const mocks = vi.hoisted(() => ({
  readStoredValueSafe: vi.fn(),
  getItemAsync: vi.fn(),
}));

// The one cross-platform read is mocked: a regression to a direct
// `expo-secure-store` call in `scope.ts` would reach the platform module
// instead, so the assertion below fails rather than the suite crashing.
vi.mock('@/lib/auth/secure-store-value', () => ({
  readStoredValueSafe: mocks.readStoredValueSafe,
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.getItemAsync }));

describe('glanceable scope SecureStore entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads both scope keys through the shared cross-platform helper', async () => {
    mocks.readStoredValueSafe.mockResolvedValue('value');

    await expect(getSelectedOrganizationId()).resolves.toBe('value');
    await expect(getActiveUserId()).resolves.toBe('value');

    expect(mocks.readStoredValueSafe).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
    expect(mocks.readStoredValueSafe).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY);
    // One helper serves both platforms: nothing reads the platform module
    // directly.
    expect(mocks.getItemAsync).not.toHaveBeenCalled();
  });
});
