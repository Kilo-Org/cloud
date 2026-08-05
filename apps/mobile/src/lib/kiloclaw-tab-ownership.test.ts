import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getItem: vi.fn<() => string | null>(),
  setItem: vi.fn<(key: string, value: string) => void>(),
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItem: mocks.getItem,
  setItem: mocks.setItem,
  deleteItemAsync: mocks.deleteItemAsync,
}));

vi.mock('@/lib/storage-keys', () => ({
  KILOCLAW_OWNED_KEY: 'kiloclaw-owned',
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('kiloclaw tab ownership', () => {
  it('reads the native store once and reports true for a stored "1"', async () => {
    mocks.getItem.mockReturnValue('1');
    const { readKiloClawOwned } = await import('./kiloclaw-tab-ownership');

    expect(readKiloClawOwned()).toBe(true);
    expect(readKiloClawOwned()).toBe(true);
    expect(mocks.getItem).toHaveBeenCalledTimes(1);
  });

  it('reports false when the native read throws', async () => {
    mocks.getItem.mockImplementation(() => {
      throw new Error('native store unavailable');
    });
    const { readKiloClawOwned } = await import('./kiloclaw-tab-ownership');

    expect(readKiloClawOwned()).toBe(false);
  });

  it('writes only a changed answer', async () => {
    mocks.setItem.mockReturnValue(undefined);
    const { persistKiloClawOwned } = await import('./kiloclaw-tab-ownership');

    persistKiloClawOwned(true);
    expect(mocks.setItem).toHaveBeenCalledTimes(1);
    expect(mocks.setItem).toHaveBeenCalledWith('kiloclaw-owned', '1');

    persistKiloClawOwned(true);
    expect(mocks.setItem).toHaveBeenCalledTimes(1);
  });

  it('clears the key and keeps the answer false without rereading the store', async () => {
    mocks.getItem.mockReturnValue('1');
    mocks.deleteItemAsync.mockResolvedValue(undefined);
    const { clearKiloClawOwned, readKiloClawOwned } = await import('./kiloclaw-tab-ownership');

    expect(readKiloClawOwned()).toBe(true);
    mocks.getItem.mockClear();

    await clearKiloClawOwned();

    expect(mocks.deleteItemAsync).toHaveBeenCalledWith('kiloclaw-owned');
    expect(readKiloClawOwned()).toBe(false);
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('orders the synchronous write before the sign-out delete and writes nothing after', async () => {
    mocks.setItem.mockReturnValue(undefined);
    mocks.deleteItemAsync.mockResolvedValue(undefined);
    const { clearKiloClawOwned, persistKiloClawOwned, readKiloClawOwned } =
      await import('./kiloclaw-tab-ownership');

    persistKiloClawOwned(true);
    await clearKiloClawOwned();

    expect(mocks.setItem).toHaveBeenCalledWith('kiloclaw-owned', '1');
    expect(mocks.deleteItemAsync).toHaveBeenCalledWith('kiloclaw-owned');
    const setCallOrder = mocks.setItem.mock.invocationCallOrder[0];
    const deleteCallOrder = mocks.deleteItemAsync.mock.invocationCallOrder[0];
    expect(setCallOrder).toBeDefined();
    expect(deleteCallOrder).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(setCallOrder!).toBeLessThan(deleteCallOrder!);
    expect(readKiloClawOwned()).toBe(false);
    expect(mocks.setItem).toHaveBeenCalledTimes(1);
    expect(mocks.deleteItemAsync).toHaveBeenCalledTimes(1);
  });

  it('blocks a late list reconcile from writing after sign-out begins', async () => {
    mocks.setItem.mockReturnValue(undefined);
    mocks.deleteItemAsync.mockResolvedValue(undefined);
    const { clearKiloClawOwned, persistKiloClawOwned, readKiloClawOwned } =
      await import('./kiloclaw-tab-ownership');

    // The old account's resolved answer is already persisted.
    persistKiloClawOwned(true);
    expect(mocks.setItem).toHaveBeenCalledTimes(1);

    // Sign-out starts; the delete is pending while the old tab layout's
    // observer reconciles a late list response.
    const clearing = clearKiloClawOwned();
    persistKiloClawOwned(true);
    await clearing;

    // A late response after the delete finishes stays blocked too.
    persistKiloClawOwned(false);

    expect(mocks.setItem).toHaveBeenCalledTimes(1);
    expect(mocks.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(readKiloClawOwned()).toBe(false);
  });

  it('lets the next signed-in account persist after reading the cleared state', async () => {
    mocks.setItem.mockReturnValue(undefined);
    mocks.deleteItemAsync.mockResolvedValue(undefined);
    const { clearKiloClawOwned, persistKiloClawOwned, readKiloClawOwned } =
      await import('./kiloclaw-tab-ownership');

    persistKiloClawOwned(true);
    await clearKiloClawOwned();

    // The next account's tab layout mount reads the cleared answer.
    expect(readKiloClawOwned()).toBe(false);

    // Its list resolves and the resolved answer persists again.
    persistKiloClawOwned(true);

    expect(mocks.setItem).toHaveBeenCalledWith('kiloclaw-owned', '1');
    expect(mocks.setItem).toHaveBeenCalledTimes(2);
  });
});
