import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readStoredValue } from './secure-store-value';

const mocks = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
}));

describe('readStoredValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored value for the key', async () => {
    mocks.getItemAsync.mockResolvedValue('stored-value');

    await expect(readStoredValue('a-key')).resolves.toBe('stored-value');
    expect(mocks.getItemAsync).toHaveBeenCalledWith('a-key', undefined);
  });

  it('forwards the platform options it is given', async () => {
    mocks.getItemAsync.mockResolvedValue(null);

    await expect(readStoredValue('a-key', { keychainService: 'kilo' })).resolves.toBeNull();
    expect(mocks.getItemAsync).toHaveBeenCalledWith('a-key', { keychainService: 'kilo' });
  });

  it('propagates a rejected read to the caller', async () => {
    mocks.getItemAsync.mockRejectedValue(new Error('keychain unavailable'));

    await expect(readStoredValue('a-key')).rejects.toThrow('keychain unavailable');
  });
});
