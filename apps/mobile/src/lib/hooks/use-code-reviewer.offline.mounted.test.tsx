import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ReviewConfigData } from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewConfigQueryKey,
  useSaveReviewConfig,
  useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const toastError = vi.hoisted(() => vi.fn());

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://gate.test/api/trpc', fetch: transport })],
    }),
  };
});
// The mutation's error toast and the permissions hook's router both reach
// modules this node environment cannot load.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: toastError, warning: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useFocusEffect: vi.fn(),
  router: { back: vi.fn() },
}));

const CONFIG = { gateThreshold: 'warning', reviewStyle: 'balanced', isEnabled: false };
const CONFIG_SUCCESS = { success: true };

const WRITE_PROCEDURES: Record<string, true> = {
  'personalReviewAgent.patchReviewConfig': true,
  'personalReviewAgent.toggleReviewAgent': true,
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

type Probe = {
  save: ((patch: { gateThreshold: 'critical' }) => Promise<unknown>) | null;
  toggle: ((vars: { isEnabled: boolean }) => Promise<unknown>) | null;
  loaded: boolean;
  key: unknown[];
};

/** The gate/style save and the platform toggle share one config query. */
function ConfigProbe({ holder }: { holder: Probe }) {
  const { data } = useReviewConfig('personal', 'github');
  holder.save = useSaveReviewConfig('personal', 'github').mutateAsync;
  holder.toggle = useToggleReviewer('personal', 'github').mutateAsync;
  holder.loaded = data !== undefined;
  holder.key = useReviewConfigQueryKey('personal', 'github');
  return null;
}

const queryClientRef: { current: ReturnType<typeof createTestQueryClient> | null } = {
  current: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = queryClientRef.current;
  if (!queryClient) {
    throw new Error('wrapper rendered before the test client was installed');
  }
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </TRPCProvider>
  );
}

async function mountConfig() {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Probe = { save: null, toggle: null, loaded: false, key: [] };
  const view = await renderWithProviders(<ConfigProbe holder={holder} />, {
    queryClient,
    wrapper,
  });
  await waitFor(() => holder.loaded);
  return { view, queryClient, holder };
}

function respondWith(options: { failWrites?: Error } = {}) {
  transport.mockImplementation(async input => {
    await Promise.resolve();
    const procedure = procedureOf(input);
    if (options.failWrites && WRITE_PROCEDURES[procedure] === true) {
      throw options.failWrites;
    }
    return Response.json({
      result: { data: WRITE_PROCEDURES[procedure] === true ? CONFIG_SUCCESS : CONFIG },
    });
  });
}

describe('code reviewer config writes while the device is offline', () => {
  beforeEach(() => {
    queryClientRef.current = null;
    transport.mockReset();
    toastError.mockReset();
    onlineManager.setOnline(true);
  });

  it('sends the threshold save instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountConfig();

    // NetInfo has committed offline, which pauses a default `networkMode:
    // 'online'` mutation forever: no request, and `mutateAsync` never settles,
    // so the screen keeps every row busy with no failure surface.
    onlineManager.setOnline(false);
    await act(async () => {
      await holder.save?.({ gateThreshold: 'critical' });
    });

    expect(callsTo('personalReviewAgent.patchReviewConfig')).toBe(1);
    expect(queryClient.getQueryData<ReviewConfigData>(holder.key)?.gateThreshold).toBe('critical');
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('restores the previous threshold and rejects when the offline save fails', async () => {
    respondWith({ failWrites: new TypeError('Network request failed') });
    const { view, queryClient, holder } = await mountConfig();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.save?.({ gateThreshold: 'critical' }).catch((error: unknown) => {
        failure = error;
      });
    });

    // The rejection is what the option screen turns into its inline Retry, and
    // the cache is back on the value the server still holds.
    expect(String(failure)).toContain('Network request failed');
    expect(queryClient.getQueryData<ReviewConfigData>(holder.key)?.gateThreshold).toBe('warning');
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('sends the reviewer toggle instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountConfig();

    onlineManager.setOnline(false);
    await act(async () => {
      await holder.toggle?.({ isEnabled: true });
    });

    expect(callsTo('personalReviewAgent.toggleReviewAgent')).toBe(1);
    expect(queryClient.getQueryData<ReviewConfigData>(holder.key)?.isEnabled).toBe(true);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('restores the reviewer switch and rejects when the offline toggle fails', async () => {
    respondWith({ failWrites: new TypeError('Network request failed') });
    const { view, queryClient, holder } = await mountConfig();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.toggle?.({ isEnabled: true }).catch((error: unknown) => {
        failure = error;
      });
    });

    expect(String(failure)).toContain('Network request failed');
    expect(queryClient.getQueryData<ReviewConfigData>(holder.key)?.isEnabled).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });
});
