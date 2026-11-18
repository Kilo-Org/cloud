import { createElement, useState } from 'react';
import type * as ReactQuery from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { useSessionMutations } from './use-session-mutations';

type Input = { session_id: string; title?: string };
type MutationOptions = ReactQuery.MutationOptions<unknown, Error, Input>;

const listKey = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;
const activeFilter = { queryKey: [['activeSessions', 'list']] };

// These modules reach react-native, whose Flow source the mounted (node)
// transform cannot parse. Only their render-time surface matters: no mutation
// runs in this suite, so inert stand-ins are enough.
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({ scheduleCacheMaintenance: vi.fn() }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// Never invoked: this suite only renders the hook, it does not run a mutation.
const rpc = { rename: vi.fn(), delete: vi.fn() };

// Real TanStack Query drives the mutation observers for this suite, so the
// only stubbed input is the procedure surface the hook reads at render time.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { infiniteQueryKey: () => listKey },
      rename: {
        mutationOptions: (options: MutationOptions) => ({ ...options, mutationFn: rpc.rename }),
      },
      delete: {
        mutationOptions: (options: MutationOptions) => ({ ...options, mutationFn: rpc.delete }),
      },
    },
    activeSessions: { list: { pathFilter: () => activeFilter } },
  }),
}));

type MutationsResult = ReturnType<typeof useSessionMutations>;

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.unmount();
  }
});

function requireRender(renders: MutationsResult[], index: number): MutationsResult {
  const render = renders[index];
  if (!render) {
    throw new Error(`expected a render at index ${index}`);
  }
  return render;
}

/** Mounts a probe that records every render's callbacks and can force one. */
async function mountProbe() {
  const renders: MutationsResult[] = [];

  function Probe() {
    const [, setTick] = useState(0);
    renders.push(useSessionMutations());
    return createElement('Button', {
      onPress: () => {
        setTick(tick => tick + 1);
      },
    });
  }

  const { renderer, unmount } = await renderWithProviders(createElement(Probe));
  mounted.push({ unmount });

  return {
    renders,
    rerender: () => {
      act(() => {
        (renderer.root.findByType('Button').props.onPress as () => void)();
      });
    },
  };
}

describe('useSessionMutations callback identity', () => {
  it('keeps deleteSession and renameSession stable across re-renders while observers are stable', async () => {
    const { renders, rerender } = await mountProbe();

    rerender();
    rerender();

    // The mutation result object is rebuilt every render while the observer's
    // mutateAsync stays stable for the hook's lifetime. If the callbacks
    // depended on the result object (or dropped useCallback), these identities
    // would change on every unrelated update and re-render every visible row.
    const first = requireRender(renders, 0);
    expect(renders.length).toBeGreaterThanOrEqual(3);
    for (const render of renders) {
      expect(render.deleteSession).toBe(first.deleteSession);
      expect(render.renameSession).toBe(first.renameSession);
      expect(render.renameSessionAsync).toBe(first.renameSessionAsync);
    }
  });
});
