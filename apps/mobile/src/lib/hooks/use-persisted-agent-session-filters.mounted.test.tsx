import { act, TestRenderer } from '@/test/renderer';
import { type ComponentType, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePersistedAgentSessionFilters } from './use-persisted-agent-session-filters';

const store = vi.hoisted(() => ({
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn<(message: string) => void>() }));

vi.mock('@/lib/auth/secure-store', () => ({ getItemAsync: store.read }));
vi.mock('@/lib/auth/secure-store-value', () => ({
  writeStoredValue: store.write,
  deleteStoredValue: vi.fn(),
  widgetStoreOptions: () => undefined,
  readStoredValue: vi.fn(),
}));
vi.mock('@/lib/telemetry/secure-store-events', () => ({
  reportSecureStoreFailure: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: toasts }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const STORAGE_KEY = 'agent-session-filters';

type HookApi = ReturnType<typeof usePersistedAgentSessionFilters>;

const renderers: TestRenderer.ReactTestRenderer[] = [];

/** Mounts the hook and hands back a live read of what it returns. */
function mount(): () => HookApi {
  const probe: { current: HookApi | null } = { current: null };
  function Probe() {
    probe.current = usePersistedAgentSessionFilters(STORAGE_KEY);
    return createElement('View', null);
  }
  const created: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    created.current = TestRenderer.create(createElement(Probe as ComponentType));
  });
  const renderer = created.current;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return () => {
    const api = probe.current;
    if (api === null) {
      throw new Error('the filters hook did not mount');
    }
    return api;
  };
}

/** One turn: letting the event loop run hands the pending microtasks another tick. */
async function flushOnce(): Promise<void> {
  const tick = Promise.withResolvers<undefined>();
  setImmediate(() => {
    tick.resolve(undefined);
  });
  await act(async () => {
    await tick.promise;
  });
}

/** Lets the load, the save, and the state they write land. */
async function flush(rounds = 8): Promise<void> {
  if (rounds === 0) {
    return;
  }
  await flushOnce();
  await flush(rounds - 1);
}

/** One write the hook started and has not finished: resolving it settles that save. */
const pendingWrites: (() => void)[] = [];

/** Settles the writes the edits scheduled, one per turn, until none are left. */
async function settleWrites(rounds: number): Promise<void> {
  if (rounds === 0) {
    return;
  }
  pendingWrites.shift()?.();
  await flush();
  await settleWrites(rounds - 1);
}

beforeEach(() => {
  store.read.mockReset();
  store.write.mockReset();
  toasts.error.mockReset();
  pendingWrites.length = 0;
  store.write.mockImplementation(async () => {
    const gate = Promise.withResolvers<undefined>();
    pendingWrites.push(() => {
      gate.resolve(undefined);
    });
    await gate.promise;
  });
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.unmount();
  }
});

describe('usePersistedAgentSessionFilters persistence', () => {
  it('does not write the defaults back when the read fails, and reports the read', async () => {
    store.read.mockRejectedValue(new Error('the keychain is locked'));
    const api = mount();

    await flush();

    expect(store.write).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledExactlyOnceWith('common.couldnTLoad');
    // The page still works: the defaults are on screen.
    expect(api().hasLoaded).toBe(true);
    expect(api().platformFilter).toEqual([]);
  });

  it('writes two rapid edits in order, behind one shared save chain', async () => {
    store.read.mockResolvedValue(null);
    const api = mount();
    await flush();
    // Loading the defaults is not a reason to write them back.
    expect(store.write).not.toHaveBeenCalled();

    act(() => {
      api().setPlatformFilter(['cli']);
    });
    await flush();
    act(() => {
      api().setProjectFilter(['https://github.com/kilo/cloud']);
    });
    await flush();

    // A re-entrant save chain would deadlock here and never reach the store.
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.write.mock.calls[0]?.[1]).toBe(
      JSON.stringify({ platformFilter: ['cli'], projectFilter: [] })
    );

    // Settle every write the edits scheduled; nothing is left waiting.
    await settleWrites(4);

    expect(pendingWrites).toEqual([]);
    expect(store.write.mock.lastCall?.[1]).toBe(
      JSON.stringify({
        platformFilter: ['cli'],
        projectFilter: ['https://github.com/kilo/cloud'],
      })
    );
  });
});
