/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as sheet-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listDirectoriesOnConnection,
  type ListDirectoriesResult,
} from '@kilocode/cloud-agent-sdk/list-directories';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const connection = vi.hoisted(() => ({}));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connection,
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

function Harness({
  connectionId,
  onRender,
}: {
  connectionId: string;
  onRender: (api: UseListDirectoriesResult) => void;
}) {
  const api = useListDirectories(connectionId);
  onRender(api);
  return null;
}

/** Mount the hook and expose the latest render's API. */
function mount(connectionId: string): {
  latest: () => UseListDirectoriesResult;
  unmount: () => void;
} {
  let current: UseListDirectoriesResult | undefined = undefined;
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(Harness, {
        connectionId,
        onRender: api => {
          current = api;
        },
      })
    );
  });
  return {
    latest: () => {
      if (!current) {
        throw new Error('hook has not rendered yet');
      }
      return current;
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

/** Flush pending promise callbacks inside an act scope. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const listFn = vi.mocked(listDirectoriesOnConnection);

describe('useListDirectories', () => {
  beforeEach(() => {
    listFn.mockReset();
  });

  it('lists a level into the ready state', async () => {
    listFn.mockResolvedValueOnce({
      ok: true,
      path: '',
      directories: [{ name: 'src', path: 'src' }],
    });
    const { latest, unmount } = mount('conn-1');

    act(() => {
      latest().list('');
    });
    await flush();

    expect(latest().state).toEqual({
      phase: 'ready',
      path: '',
      directories: [{ name: 'src', path: 'src' }],
    });
    unmount();
  });

  it('keeps an empty listing in the ready state (empty picker body)', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const { latest, unmount } = mount('conn-1');

    act(() => {
      latest().list('');
    });
    await flush();

    expect(latest().state).toEqual({ phase: 'ready', path: '', directories: [] });
    unmount();
  });

  it('maps a transport failure to the retryable state', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'transport' });
    const { latest, unmount } = mount('conn-1');

    act(() => {
      latest().list('src');
    });
    await flush();

    expect(latest().state).toEqual({ phase: 'retryable', path: 'src' });
    unmount();
  });

  it('maps unsupported and invalid results to the permanent unsupported state', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
    const first = mount('conn-1');
    act(() => {
      first.latest().list('src');
    });
    await flush();
    expect(first.latest().state).toEqual({ phase: 'unsupported', path: 'src' });
    first.unmount();

    listFn.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    const second = mount('conn-1');
    act(() => {
      second.latest().list('src');
    });
    await flush();
    expect(second.latest().state).toEqual({ phase: 'unsupported', path: 'src' });
    second.unmount();
  });

  it('ignores a late child listing after Back restores the cached parent', async () => {
    const root = { name: 'src', path: 'src' };
    const child = { name: 'server', path: 'src/server' };
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [root] });

    const { latest, unmount } = mount('conn-1');

    // List the launch path to completion.
    act(() => {
      latest().list('');
    });
    await flush();
    expect(latest().state).toEqual({ phase: 'ready', path: '', directories: [root] });

    // Drill into the child, but keep that listing in flight.
    let resolveDrill: ((value: ListDirectoriesResult) => void) | undefined = undefined;
    const drillPromise = new Promise<ListDirectoriesResult>(resolve => {
      resolveDrill = resolve;
    });
    listFn.mockReturnValueOnce(drillPromise);
    act(() => {
      latest().list('src');
    });
    expect(latest().state).toEqual({ phase: 'skeleton', path: 'src' });

    // Back restores the cached parent and advances the generation.
    act(() => {
      latest().list('');
    });
    expect(latest().state).toEqual({ phase: 'ready', path: '', directories: [root] });

    // The child listing resolves late; it must not replace the restored parent.
    await act(async () => {
      resolveDrill?.({ ok: true, path: 'src', directories: [child] });
      await Promise.resolve();
    });
    expect(latest().state).toEqual({ phase: 'ready', path: '', directories: [root] });
    unmount();
  });
});
