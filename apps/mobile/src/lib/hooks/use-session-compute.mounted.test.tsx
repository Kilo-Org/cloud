import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COMPUTE_POLL_MS } from '@/lib/session-compute-total';

import { useSessionComputeCharges } from './use-session-compute';

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  options: undefined as { refetchInterval?: number | false } | undefined,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    computeBilling: {
      sessionCharges: {
        queryOptions: (_input: unknown, options: object) => {
          state.options = options as { refetchInterval?: number | false };
          return {
            queryKey: [['computeBilling', 'sessionCharges']],
            queryFn: state.fetch,
            ...options,
          };
        },
      },
    },
  }),
}));

const CLOUD_SESSION_ID = 'workspace_5c1a3f0e-2b7d-4c9a-8f6e-1d2b3c4d5e6f';

/**
 * What a session answers before any run has charged, or after every run
 * stopped. Polling must not depend on it: a run that starts after this read, or
 * a run read before its first charged segment exists, is only observable by
 * re-reading.
 */
const IDLE_CHARGES = {
  amountMicrodollars: 0,
  seconds: 0,
  scope: 'session',
  runs: [],
  earlierRuns: null,
};

function ChargesProbe({ poll }: Readonly<{ poll?: boolean }>) {
  useSessionComputeCharges({
    cloudAgentSessionId: CLOUD_SESSION_ID,
    organizationId: undefined,
    poll,
  });
  return null;
}

async function mountProbe(poll: boolean | undefined): Promise<TestRenderer.ReactTestRenderer> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(ChargesProbe, { poll }))
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

beforeEach(() => {
  state.fetch.mockReset();
  state.fetch.mockResolvedValue(IDLE_CHARGES);
  state.options = undefined;
});

// This project mounts without a DOM, so TanStack's module-level `isServer()`
// disables every timer it would otherwise schedule; the interval is asserted as
// configured here rather than by advancing a clock that the library ignores.
describe('useSessionComputeCharges polling', () => {
  it('asks for a timed poll instead of one gated on the cached runs', async () => {
    const renderer = await mountProbe(undefined);

    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.options).toMatchObject({
      enabled: true,
      refetchOnWindowFocus: false,
      refetchInterval: SESSION_COMPUTE_POLL_MS,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves the timer to the caller that owns the shared read', async () => {
    const renderer = await mountProbe(false);

    expect(state.options?.refetchInterval).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });
});
