import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => secureStore);

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

// A disk read the test settles by hand, to put a write in front of it. Settling
// before the test installs its resolver is a bug in the test, not a state.
function unsettled(): void {
  throw new Error('the disk read was settled before the test installed its resolver');
}

const diskRead: { settle: (raw: string) => void } = { settle: unsettled };

beforeEach(() => {
  vi.resetModules();
  secureStore.getItemAsync.mockReset();
  secureStore.setItemAsync.mockReset();
  secureStore.deleteItemAsync.mockReset();
  secureStore.setItemAsync.mockResolvedValue(undefined);
  secureStore.deleteItemAsync.mockResolvedValue(undefined);
  diskRead.settle = unsettled;
});

/**
 * The settings registry reads this store with no React tree, so the store has to
 * start its disk read at module scope. These tests import the module fresh to
 * observe the preload the import itself performs.
 */
describe('persisted agent model store', () => {
  it('preloads the stored map so a non-React read sees every context', async () => {
    secureStore.getItemAsync.mockResolvedValue(
      JSON.stringify({ org_other: { model: 'openai/gpt', variant: '' } })
    );

    const { getStoredModelPreference } = await import('./use-persisted-agent-model');

    await vi.waitFor(() => {
      expect(getStoredModelPreference('org_other')).toEqual({ model: 'openai/gpt', variant: '' });
    });
  });

  it('keeps the other contexts when a write races the initial disk read', async () => {
    secureStore.getItemAsync.mockReturnValue(
      new Promise<string>(resolve => {
        diskRead.settle = resolve;
      })
    );

    const { getStoredModelPreference, setDefaultModelForContext } =
      await import('./use-persisted-agent-model');

    // The write lands before the disk read has settled, so the in-memory map
    // holds only this context. The persisted map must be merged back in.
    setDefaultModelForContext('org_new', { model: 'anthropic/claude', variant: 'thinking' });

    diskRead.settle(JSON.stringify({ org_other: { model: 'openai/gpt', variant: '' } }));

    await vi.waitFor(() => {
      expect(getStoredModelPreference('org_other')).toEqual({ model: 'openai/gpt', variant: '' });
    });
    expect(getStoredModelPreference('org_new')).toEqual({
      model: 'anthropic/claude',
      variant: 'thinking',
    });

    const merged = JSON.stringify({
      org_other: { model: 'openai/gpt', variant: '' },
      org_new: { model: 'anthropic/claude', variant: 'thinking' },
    });
    await vi.waitFor(() => {
      expect(secureStore.setItemAsync).toHaveBeenCalledWith('agent-model-preference', merged);
    });
  });
});
