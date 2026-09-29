import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}

beforeEach(() => {
  vi.resetModules();
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  captureException.mockReset();
  toastError.mockReset();
});

const PREFERENCE_KEY = 'install-attribution-prompt-seen';

describe('install attribution prompt preference', () => {
  it('reads the explainer as unanswered when nothing is stored', async () => {
    getItemAsync.mockResolvedValue(null);
    const mod = await import('./install-attribution-prompt-preference');

    await mod.whenInstallAttributionPromptSeenLoaded();

    expect(mod.readInstallAttributionPromptSeen()).toBe(false);
  });

  it("reads a stored 'true' as answered", async () => {
    getItemAsync.mockResolvedValue('true');
    const mod = await import('./install-attribution-prompt-preference');

    await mod.whenInstallAttributionPromptSeenLoaded();

    expect(mod.readInstallAttributionPromptSeen()).toBe(true);
  });

  it("marks the explainer answered and persists 'true'", async () => {
    getItemAsync.mockResolvedValue(null);
    const mod = await import('./install-attribution-prompt-preference');

    await mod.whenInstallAttributionPromptSeenLoaded();
    mod.markInstallAttributionPromptSeen();
    await flushMicrotasks();

    expect(mod.readInstallAttributionPromptSeen()).toBe(true);
    expect(setItemAsync).toHaveBeenCalledWith(PREFERENCE_KEY, 'true');
  });
});
