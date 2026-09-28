/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the scope module from disk to pin the one cross-platform SecureStore entry point */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { getActiveUserId, getSelectedOrganizationId } from './scope';

const mocks = vi.hoisted(() => ({
  readStoredValueSafe: vi.fn(),
  getItemAsync: vi.fn(),
}));

// The one cross-platform read is mocked: a regression to a direct
// `expo-secure-store` import in `scope.ts` would call the platform module
// instead, so the assertions below fail rather than crash the suite.
vi.mock('@/lib/auth/secure-store-value', () => ({
  readStoredValueSafe: mocks.readStoredValueSafe,
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.getItemAsync }));

const SCOPE_SOURCE = readFileSync(join(__dirname, 'scope.ts'), 'utf8');

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
    expect(mocks.getItemAsync).not.toHaveBeenCalled();
  });

  it('keeps no per-platform storage branch: one helper serves iOS and Android', () => {
    expect(SCOPE_SOURCE).toContain("from '@/lib/auth/secure-store-value'");
    expect(SCOPE_SOURCE).not.toMatch(/from ['"]expo-secure-store['"]/);
  });
});
