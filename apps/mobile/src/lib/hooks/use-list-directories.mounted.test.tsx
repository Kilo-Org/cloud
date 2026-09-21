import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listDirectoriesOnConnection,
  type ListDirectoriesResult,
} from '@kilocode/cloud-agent-sdk/list-directories';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const connection = vi.hoisted(() => {
  let connected = false;
  return {
    isConnected: vi.fn(() => connected),
    setConnected: (next: boolean) => {
      connected = next;
    },
    retryConnection: vi.fn(),
  };
});

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connection,
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

type Probe = { current: UseListDirectoriesResult | null };

function Harness({ connectionId, probe }: { connectionId: string | null; probe: Probe }) {
  probe.current = useListDirectories(connectionId);
  return null;
}

/** Mount the hook inside the app's QueryClientProvider and expose the latest API. */
async function mount(connectionId: string | null = 'conn-1', queryClient?: QueryClient) {
  const probe: Probe = { current: null };
  const rendered = await renderWithProviders(createElement(Harness, { connectionId, probe }), {
    queryClient,
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

const listFn = vi.mocked(listDirectoriesOnConnection);
const src = { name: 'src', path: 'src' };
const server = { name: 'server', path: 'src/server' };

describe('useListDirectories', () => {
  beforeEach(() => {
    listFn.mockReset();
    connection.retryConnection.mockClear();
    // The picker only lists over a live transport; a rebuilding one is the
    // exception, and the transport-failure, nudge and retry-pacing cases live
    // in the transport mounted suite.
    connection.setConnected(true);
  });

  it('lists the launch path into the ready state', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [src] });
    const { api, unmount } = await mount('conn-1');

    // Nothing requested yet: the picker renders its skeleton branch.
    expect(api().state).toBeNull();

    act(() => {
      api().list('');
    });
    expect(api().state).toEqual({ phase: 'skeleton', path: '' });
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledWith(connection, 'conn-1', undefined);

    await waitFor(() => api().state?.phase === 'ready');
    expect(api().state).toEqual({ phase: 'ready', path: '', directories: [src] });
    unmount();
  });

  it('keeps an empty listing in the ready state (empty picker body)', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('');
    });
    await waitFor(() => api().state?.phase === 'ready');
    expect(api().state).toEqual({ phase: 'ready', path: '', directories: [] });
    unmount();
  });

  it('serves a previously listed path from cache with no second SDK call', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [src] });
    listFn.mockResolvedValueOnce({ ok: true, path: 'src', directories: [server] });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('');
    });
    await waitFor(() => api().state?.phase === 'ready');

    act(() => {
      api().list('src');
    });
    expect(api().state).toEqual({ phase: 'skeleton', path: 'src' });
    await waitFor(() => api().state?.phase === 'ready');
    expect(api().state).toEqual({ phase: 'ready', path: 'src', directories: [server] });

    // Back: the launch path is served from its cached query, so no skeleton and
    // no network wait.
    act(() => {
      api().list('');
    });
    expect(api().state).toEqual({ phase: 'ready', path: '', directories: [src] });

    await act(async () => {
      await Promise.resolve();
    });
    expect(listFn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('lists the launch path again after the picker reopens', async () => {
    // The listing cache must end with the sheet: a reopen must show the
    // skeleton and fetch the launch path again, exactly as the replaced
    // per-hook `cacheRef` did. Reuse one client so the app-wide query cache
    // survives the first unmount (the harness `unmount({ clear })` would hide
    // the defect); unmount through the renderer so the hook's cleanup runs.
    const client = createTestQueryClient();
    listFn.mockResolvedValue({ ok: true, path: '', directories: [src] });

    const first = await mount('conn-1', client);
    act(() => {
      first.api().list('');
    });
    await waitFor(() => first.api().state?.phase === 'ready');
    expect(first.api().state).toEqual({ phase: 'ready', path: '', directories: [src] });
    expect(listFn).toHaveBeenCalledTimes(1);

    act(() => {
      first.renderer.unmount();
    });

    const second = await mount('conn-1', client);
    act(() => {
      second.api().list('');
    });
    // Step 4: the reopen must not serve the previous session's listing.
    expect(second.api().state).toEqual({ phase: 'skeleton', path: '' });
    await waitFor(() => second.api().state?.phase === 'ready');
    expect(second.api().state).toEqual({ phase: 'ready', path: '', directories: [src] });
    expect(listFn).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('keeps list referentially stable so the picker mount effect runs once', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [src] });
    const { api, unmount } = await mount('conn-1');

    const list = api().list;
    act(() => {
      api().list('');
    });
    await waitFor(() => api().state?.phase === 'ready');
    expect(api().list).toBe(list);
    unmount();
  });

  it('maps unsupported and invalid results to the permanent unsupported state', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
    const first = await mount('conn-1');
    act(() => {
      first.api().list('src');
    });
    await waitFor(() => first.api().state?.phase === 'unsupported');
    expect(first.api().state).toEqual({ phase: 'unsupported', path: 'src' });
    first.unmount();

    listFn.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    const second = await mount('conn-1');
    act(() => {
      second.api().list('src');
    });
    await waitFor(() => second.api().state?.phase === 'unsupported');
    expect(second.api().state).toEqual({ phase: 'unsupported', path: 'src' });
    second.unmount();
  });

  it('stays on the skeleton and never calls the SDK without a connection', async () => {
    const { api, unmount } = await mount(null);

    act(() => {
      api().list('');
    });
    expect(api().state).toEqual({ phase: 'skeleton', path: '' });

    await act(async () => {
      await Promise.resolve();
    });
    expect(listFn).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores a late child listing after Back restores the cached parent', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [src] });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('');
    });
    await waitFor(() => api().state?.phase === 'ready');

    // Drill into the child, but keep that listing in flight.
    let resolveDrill: ((result: ListDirectoriesResult) => void) | undefined = undefined;
    const drill = new Promise<ListDirectoriesResult>(resolve => {
      resolveDrill = resolve;
    });
    listFn.mockReturnValueOnce(drill);
    act(() => {
      api().list('src');
    });
    expect(api().state).toEqual({ phase: 'skeleton', path: 'src' });

    // Back restores the cached parent while the child listing is still pending.
    act(() => {
      api().list('');
    });
    expect(api().state).toEqual({ phase: 'ready', path: '', directories: [src] });

    // The child listing resolves late; it must not replace the restored parent.
    await act(async () => {
      resolveDrill?.({ ok: true, path: 'src', directories: [server] });
      await Promise.resolve();
    });
    expect(api().state).toEqual({ phase: 'ready', path: '', directories: [src] });
    unmount();
  });
});
