import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import { createKiloAppQueryClient } from '@/lib/query-client';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ isConnected: () => true, retryConnection: vi.fn() }),
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

type Probe = { current: UseListDirectoriesResult | null };

function Harness({ probe }: { probe: Probe }) {
  probe.current = useListDirectories('conn-1');
  return null;
}

const listFn = vi.mocked(listDirectoriesOnConnection);
const src = { name: 'src', path: 'src' };

let events: TelemetryEvent[] = [];
let client = createKiloAppQueryClient();

/** Mount the hook on the app's real query client, so `QueryCache.onError` reporting runs. */
async function mount() {
  client = createKiloAppQueryClient();
  const probe: Probe = { current: null };
  const rendered = await renderWithProviders(createElement(Harness, { probe }), {
    queryClient: client,
  });
  return {
    ...rendered,
    api: () => {
      if (probe.current === null) {
        throw new Error('hook has not rendered yet');
      }
      return probe.current;
    },
  };
}

/** Poll on real timers: the Retry pauses between its sends. */
async function waitForRealTimers(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitForRealTimers: condition not met');
    }
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially, one real tick at a time
    await act(async () => {
      const tick = Promise.withResolvers<unknown>();
      setTimeout(tick.resolve, 25);
      await tick.promise;
    });
  }
}

describe('useListDirectories error reporting', () => {
  beforeEach(() => {
    listFn.mockReset();
    events = [];
    setTelemetrySink(event => {
      events.push(event);
    });
  });

  afterEach(() => {
    setTelemetrySink(null);
    client.clear();
  });

  it('sends one warning event with the cause for a failed listing', async () => {
    const failure = new Error('socket closed');
    listFn.mockResolvedValue({ ok: false, reason: 'transport', cause: failure });
    const { api, unmount } = await mount();

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warning',
      fingerprint: ['cli-command-unavailable', 'list_directories'],
      tags: { 'error.subsystem': 'cli-command', 'error.operation': 'list_directories' },
    });
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error).toMatchObject({
      message: 'directory listing unavailable',
      cause: failure,
    });
    unmount();
  });

  it('sends no event when a Retry send fails and the next send succeeds', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'transport', cause: new Error('first') });
    const { api, unmount } = await mount();
    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');
    events = [];

    listFn
      .mockResolvedValueOnce({ ok: false, reason: 'transport', cause: new Error('relay restart') })
      .mockResolvedValueOnce({ ok: true, path: 'src', directories: [src] });
    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'ready');

    expect(listFn).toHaveBeenCalledTimes(3);
    expect(events).toEqual([]);
    unmount();
  });

  it.each(['unsupported', 'invalid'] as const)('sends no event for an %s listing', async reason => {
    listFn.mockResolvedValue({ ok: false, reason });
    const { api, unmount } = await mount();

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'unsupported');

    expect(api().state).toEqual({ phase: 'unsupported', path: 'src' });
    expect(events).toEqual([]);
    unmount();
  });
});
