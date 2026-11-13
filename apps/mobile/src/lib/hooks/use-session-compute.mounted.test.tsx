import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COMPUTE_POLL_MS } from '@/lib/session-compute-total';

import { useSessionComputeCharges } from './use-session-compute';

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  options: undefined as
    | {
        enabled?: boolean;
        refetchInterval?: number | false | ((query: unknown) => number | false);
      }
    | undefined,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    computeBilling: {
      sessionCharges: {
        queryOptions: (_input: unknown, options: object) => {
          state.options = options;
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
const LOCAL_SESSION_ID = 'ses_123';

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

function ChargesProbe({
  poll,
  sessionId = CLOUD_SESSION_ID,
}: Readonly<{ poll?: boolean; sessionId?: string }>) {
  useSessionComputeCharges({
    cloudAgentSessionId: sessionId,
    organizationId: undefined,
    poll,
  });
  return null;
}

type Mounted = {
  renderer: TestRenderer.ReactTestRenderer;
  client: QueryClient;
};

async function mountProbe({
  poll,
  sessionId,
}: Readonly<{ poll?: boolean; sessionId?: string }> = {}): Promise<Mounted> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ChargesProbe, { poll, sessionId })
      )
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { renderer, client };
}

/** The interval the hook configured, resolved the way TanStack resolves it. */
function pollInterval({ client }: Mounted): number | false {
  const option = state.options?.refetchInterval;
  if (option === undefined) {
    throw new Error('the hook configured no refetchInterval');
  }
  if (typeof option !== 'function') {
    return option;
  }
  const query = client.getQueryCache().getAll()[0];
  if (query === undefined) {
    throw new Error('the read mounted no query');
  }
  return option(query);
}

/** A tRPC client error carrying the server's verdict. */
function trpcError(code: string): Error {
  return Object.assign(new Error(code), { data: { code } });
}

beforeEach(() => {
  state.fetch.mockReset();
  state.fetch.mockResolvedValue(IDLE_CHARGES);
  state.options = undefined;
});

// This project mounts without a DOM, so TanStack's module-level `isServer()`
// disables every timer it would otherwise schedule; the interval is asserted as
// configured and resolved against the read's real state, rather than by
// advancing a clock the library ignores.
describe('useSessionComputeCharges polling', () => {
  it('polls on a timer, not from the cached runs, so a later run is observed', async () => {
    const mounted = await mountProbe();

    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.options?.enabled).toBe(true);
    expect(pollInterval(mounted)).toBe(SESSION_COMPUTE_POLL_MS);

    act(() => {
      mounted.renderer.unmount();
    });
  });

  it('leaves the timer to the caller that owns the shared read', async () => {
    const mounted = await mountProbe({ poll: false });

    expect(pollInterval(mounted)).toBe(false);

    act(() => {
      mounted.renderer.unmount();
    });
  });

  it.each(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'])(
    'stops polling once the read is denied with %s',
    async code => {
      state.fetch.mockRejectedValue(trpcError(code));
      const mounted = await mountProbe();

      expect(pollInterval(mounted)).toBe(false);

      act(() => {
        mounted.renderer.unmount();
      });
    }
  );

  it('keeps polling when the last read failed in a way a retry can fix', async () => {
    state.fetch.mockRejectedValue(new Error('network request failed'));
    const mounted = await mountProbe();

    expect(pollInterval(mounted)).toBe(SESSION_COMPUTE_POLL_MS);

    act(() => {
      mounted.renderer.unmount();
    });
  });

  it('does not poll a session the compute routers cannot address', async () => {
    const mounted = await mountProbe({ sessionId: LOCAL_SESSION_ID });

    expect(state.options?.enabled).toBe(false);
    expect(pollInterval(mounted)).toBe(false);

    act(() => {
      mounted.renderer.unmount();
    });
  });
});
