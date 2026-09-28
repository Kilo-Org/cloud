// Shared mount harness for offline-banner.mounted.test.tsx. The mutable refs
// below are reset by that suite's beforeEach/afterEach; keeping them here lets
// the suite stay under the max-lines budget without duplicating the provider
// stack. This module is imported by the test file, whose hoisted vi.mock
// registrations are already in place when these imports evaluate.

import { type ReactElement } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

import { type ConnectivityState, isOnline } from '@/lib/connectivity-online';
import { TRPCProvider } from '@/lib/trpc';
import { OfflineBanner } from './offline-banner';
import { type MobileRouter } from '@kilocode/trpc/mobile';

/** The fetch transport the tRPC client answers with; scripted per test. */
export const transport = vi.fn<typeof fetch>();

const settingsData = {
  isEnabled: false,
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [],
  analysisMode: 'auto',
};

const trpcClient = createTRPCClient<MobileRouter>({
  links: [httpLink({ url: 'https://settings.test/api/trpc', fetch: transport })],
});

/** Mutable harness state the owning suite resets around each test. */
export const harness = {
  queryClient: new QueryClient(),
  renderers: [] as TestRenderer.ReactTestRenderer[],
  sourceListener: undefined as ((value: ConnectivityState) => void) | undefined,
};

/** Mounts the banner (or any element) under the shared provider stack. */
export async function mountTree(element: ReactElement = <OfflineBanner />) {
  await act(() => {
    harness.renderers.push(
      TestRenderer.create(
        <QueryClientProvider client={harness.queryClient}>
          <TRPCProvider trpcClient={trpcClient} queryClient={harness.queryClient}>
            {element}
          </TRPCProvider>
        </QueryClientProvider>
      )
    );
  });
  const renderer = harness.renderers.at(-1);
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export function findHost(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}

/** Commits a NetInfo report into the online manager and the test source. */
export function emit(value: ConnectivityState) {
  act(() => {
    onlineManager.setOnline(isOnline(value));
    harness.sourceListener?.(value);
  });
}

export async function advanceBy(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The paused-transport tRPC payload the settings-screen scenario reads. */
export function settingsResponse(procedure: string): unknown {
  const data: Record<string, unknown> = {
    getConfig: settingsData,
    getRepositories: [{ id: 1, full_name: 'kilo/repo' }],
    list: [{ organizationId: 'org_123', role: 'owner' }],
  };
  return { result: { data: data[procedure] } };
}
