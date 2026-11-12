import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_STORE_PROBE } from '@/lib/auth/secure-store-gated';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { _setScopeStoreForTests, getActiveUserId, getSelectedOrganizationId } from './scope';

const mocks = vi.hoisted(() => ({ getItemAsync: vi.fn() }));

// The one cross-platform read is stubbed with the platform module's own shape: a
// regression to a direct `expo-secure-store` call in `scope.ts` cannot reach the
// lazy native load, so the reads come back absent and the assertions below fail
// rather than the suite crashing.
const store = { getItemAsync: mocks.getItemAsync };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getItemAsync.mockImplementation((key: string) =>
    key === WIDGET_STORE_PROBE.key ? WIDGET_STORE_PROBE.value : 'value'
  );
  _setScopeStoreForTests(store);
});

afterEach(() => {
  _setScopeStoreForTests(null);
});

describe('glanceable scope SecureStore entry point', () => {
  it('reads both scope keys through the shared cross-platform store', async () => {
    await expect(getSelectedOrganizationId()).resolves.toBe('value');
    await expect(getActiveUserId()).resolves.toBe('value');

    expect(mocks.getItemAsync).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY);
  });
});
