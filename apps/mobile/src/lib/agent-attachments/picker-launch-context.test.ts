import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPickerLaunchContext,
  clearPickerRestoreRecord,
  type PickerLaunchContext,
  readPickerLaunchContext,
  readPickerRestoreRecord,
  writePickerLaunchContext,
  writePickerRestoreRecord,
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
      organizationId: null,
      launchedAt: 1_700_000_000_000,
    };

    await writePickerLaunchContext(context);
    expect(await readPickerLaunchContext()).toEqual(context);

    await clearPickerLaunchContext();
    expect(await readPickerLaunchContext()).toBeNull();
  });

  it('round-trips the organization a new-session launch was scoped to', async () => {
    await writePickerLaunchContext({
      userId: 'user-1',
      surface: 'agent-new',
      sessionId: null,
      organizationId: 'org_123',
      launchedAt: 1_700_000_000_000,
    });

    expect(await readPickerLaunchContext()).toMatchObject({ organizationId: 'org_123' });
  });

  it('reads a context stored before the organization field as unscoped', async () => {
    store.set(
      PICKER_LAUNCH_CONTEXT_KEY,
      JSON.stringify({
        userId: 'user-1',
        surface: 'agent-new',
        sessionId: null,
        launchedAt: 1_700_000_000_000,
      })
    );

    expect(await readPickerLaunchContext()).toMatchObject({ organizationId: null });
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

  it('keeps the composer record apart from the launch context', async () => {
    const context: PickerLaunchContext = {
      userId: 'user-1',
      surface: 'agent-new',
      sessionId: null,
      organizationId: 'org_123',
      launchedAt: 1_700_000_000_000,
    };

    await writePickerLaunchContext(context);
    await writePickerRestoreRecord(context);

    // Consuming the result leaves the record: a start still has the composer
    // to reopen when the picker never came back to it.
    await clearPickerLaunchContext();
    expect(await readPickerLaunchContext()).toBeNull();
    expect(await readPickerRestoreRecord()).toEqual(context);

    await clearPickerRestoreRecord();
    expect(await readPickerRestoreRecord()).toBeNull();
  });
});
