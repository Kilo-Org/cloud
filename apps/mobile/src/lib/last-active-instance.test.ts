import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<() => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock('@/lib/storage-keys', () => ({
  LAST_ACTIVE_INSTANCE_KEY: 'last-active-chat-instance',
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('last active instance', () => {
  it('updates the in-memory fallback before persisting the sandbox id', async () => {
    mocks.setItemAsync.mockResolvedValue(undefined);
    const { getLastActiveInstance, setLastActiveInstance } = await import('./last-active-instance');

    const write = setLastActiveInstance('sandbox-b');

    expect(getLastActiveInstance()).toBe('sandbox-b');
    await write;
    expect(mocks.setItemAsync).toHaveBeenCalledWith('last-active-chat-instance', 'sandbox-b');
  });

  it('keeps an explicitly focused sandbox ahead of the initial load fallback', async () => {
    mocks.getItemAsync.mockResolvedValue('sandbox-a');
    mocks.setItemAsync.mockResolvedValue(undefined);
    const { getLastActiveInstance, loadLastActiveInstance, setLastActiveInstance } =
      await import('./last-active-instance');

    await setLastActiveInstance('sandbox-b');
    await loadLastActiveInstance();

    expect(getLastActiveInstance()).toBe('sandbox-b');
  });
});
