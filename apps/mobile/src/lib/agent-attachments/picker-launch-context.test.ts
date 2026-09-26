import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPickerLaunchContext,
  type PickerLaunchContext,
  readPickerLaunchContext,
  writePickerLaunchContext,
} from './picker-launch-context';
import { PICKER_LAUNCH_CONTEXT_KEY } from '@/lib/storage-keys';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

beforeEach(() => {
  store.clear();
});

describe('picker launch context', () => {
  it('round-trips the picture surface so Android recovery can match it', async () => {
    const context: PickerLaunchContext = {
      userId: 'user-1',
      surface: 'agent-picture',
      sessionId: null,
      launchedAt: 1_700_000_000_000,
    };

    await writePickerLaunchContext(context);
    expect(await readPickerLaunchContext()).toEqual(context);

    await clearPickerLaunchContext();
    expect(await readPickerLaunchContext()).toBeNull();
  });

  it('reads null for a stored surface outside the union', async () => {
    store.set(
      PICKER_LAUNCH_CONTEXT_KEY,
      JSON.stringify({
        userId: 'user-1',
        surface: 'agent-unknown',
        sessionId: null,
        launchedAt: 1_700_000_000_000,
      })
    );

    expect(await readPickerLaunchContext()).toBeNull();
  });
});
