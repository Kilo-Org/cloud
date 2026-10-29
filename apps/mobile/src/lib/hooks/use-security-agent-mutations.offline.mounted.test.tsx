import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { securityConfigFixture } from '@/components/security-agent/security-config.test-fixture';
import {
  useSaveSecurityAgentConfig,
  useSecurityAgentConfig,
  useSetSecurityAgentEnabled,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent';
import { trpcClient, TRPCProvider, useTRPC } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const toastError = vi.hoisted(() => vi.fn());
const outbox = vi.hoisted(() => ({
  writeReconcileFirst: vi.fn((row: { operationKey: string }) => Promise.resolve(row.operationKey)),
  remove: vi.fn(() => Promise.resolve()),
  whenLoaded: vi.fn(() => Promise.resolve(true)),
}));

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://security.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: toastError, warning: vi.fn() },
}));
// expo-crypto cannot load in this node project.
vi.mock('@/lib/operation-key', () => ({
  useHoistedOperationKey: () => ({ getKey: () => 'key-1', rotateKey: vi.fn() }),
}));
// The outbox store is expo-sqlite backed and has its own suites.
vi.mock('@/lib/persist/use-mutation-outbox', () => ({ useMutationOutbox: () => outbox }));
// Idle-time cache chores need `requestIdleCallback`, which this node project
// does not provide; their own suite covers them.
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useFocusEffect: vi.fn(),
  router: { back: vi.fn() },
}));
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false },
  useColorScheme: () => 'light',
}));

const CONFIG_KEY = 'securityAgent.getConfig';

/** What the server holds; a save answers with the patched row it stored. */
let storedConfig: Record<string, unknown> = {};
let failWrites: Error | null = null;

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

type Probe = {
  save: ((patch: { analysisMode: 'deep' }) => Promise<unknown>) | null;
  toggle: ((vars: { isEnabled: boolean }) => Promise<unknown>) | null;
  sync: ((vars: { repoFullName?: string }) => Promise<unknown>) | null;
  savePending: boolean;
  togglePending: boolean;
  syncPending: boolean;
  loaded: boolean;
  syncError: string | null;
  key: readonly unknown[];
};

/** The config save, the enable toggle, and the manual sync of one scope. */
function SecurityProbe({ holder }: { holder: Probe }) {
  const trpc = useTRPC();
  const { data } = useSecurityAgentConfig('personal');
  const save = useSaveSecurityAgentConfig('personal');
  const toggle = useSetSecurityAgentEnabled('personal');
  const sync = useTriggerSecuritySync('personal');
  holder.save = save.mutateAsync;
  holder.toggle = toggle.mutateAsync;
  holder.sync = sync.mutateAsync;
  holder.savePending = save.isPending;
  holder.togglePending = toggle.isPending;
  holder.syncPending = sync.isPending;
  holder.syncError = sync.error instanceof Error ? sync.error.message : null;
  holder.loaded = data !== undefined;
  holder.key = trpc.securityAgent.getConfig.queryKey();
  return null;
}

const queryClientRef = { current: createTestQueryClient() };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClientRef.current}>
      {children}
    </TRPCProvider>
  );
}

function respondWith() {
  transport.mockImplementation(async input => {
    await Promise.resolve();
    const procedure = procedureOf(input);
    if (failWrites && procedure !== CONFIG_KEY) {
      throw failWrites;
    }
    if (procedure === CONFIG_KEY) {
      return Response.json({ result: { data: storedConfig } });
    }
    return Response.json({ result: { data: { success: true } } });
  });
}

async function mountProbe() {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Probe = {
    save: null,
    toggle: null,
    sync: null,
    savePending: false,
    togglePending: false,
    syncPending: false,
    loaded: false,
    syncError: null,
    key: [],
  };
  const view = await renderWithProviders(<SecurityProbe holder={holder} />, {
    queryClient,
    wrapper,
  });
  await waitFor(() => holder.loaded);
  return { view, queryClient, holder };
}

function cachedConfig(
  queryClient: ReturnType<typeof createTestQueryClient>,
  key: readonly unknown[]
) {
  return queryClient.getQueryData<Record<string, unknown>>(key);
}

describe('Security Agent settings writes while the device is offline', () => {
  beforeEach(() => {
    storedConfig = structuredClone(securityConfigFixture);
    failWrites = null;
    transport.mockReset();
    toastError.mockReset();
    outbox.writeReconcileFirst.mockClear();
    outbox.remove.mockClear();
    onlineManager.setOnline(true);
  });

  it('sends the config save instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountProbe();
    storedConfig = { ...storedConfig, analysisMode: 'deep' };

    // NetInfo has committed offline, which pauses a default `networkMode:
    // 'online'` mutation forever: no request, `mutateAsync` never settles, and
    // the settings header keeps Save disabled with no failure surface.
    onlineManager.setOnline(false);
    await act(async () => {
      await holder.save?.({ analysisMode: 'deep' });
    });

    expect(callsTo('securityAgent.saveConfig')).toBe(1);
    expect(holder.savePending).toBe(false);
    expect(cachedConfig(queryClient, holder.key)).toMatchObject({ analysisMode: 'deep' });
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('restores the draft baseline and stops pending when the offline save fails', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountProbe();
    failWrites = new TypeError('Network request failed');

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.save?.({ analysisMode: 'deep' }).catch((error: unknown) => {
        failure = error;
      });
    });

    // The rejection is what the header Save button catches while it stays on
    // screen, and the cache is back on the value the server still holds.
    expect(String(failure)).toContain('Network request failed');
    expect(holder.savePending).toBe(false);
    expect(cachedConfig(queryClient, holder.key)).toMatchObject({ analysisMode: 'auto' });
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('sends the enable toggle instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountProbe();
    storedConfig = { ...storedConfig, isEnabled: true };

    onlineManager.setOnline(false);
    await act(async () => {
      await holder.toggle?.({ isEnabled: true });
    });

    expect(callsTo('securityAgent.setEnabled')).toBe(1);
    expect(holder.togglePending).toBe(false);
    expect(cachedConfig(queryClient, holder.key)).toMatchObject({ isEnabled: true });
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('restores the enable switch and stops pending when the offline toggle fails', async () => {
    respondWith();
    const { view, queryClient, holder } = await mountProbe();
    failWrites = new TypeError('Network request failed');

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.toggle?.({ isEnabled: true }).catch((error: unknown) => {
        failure = error;
      });
    });

    expect(String(failure)).toContain('Network request failed');
    expect(holder.togglePending).toBe(false);
    expect(cachedConfig(queryClient, holder.key)).toMatchObject({ isEnabled: false });
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('settles a manual sync that fails offline and keeps the reconcile row', async () => {
    respondWith();
    const { view, holder } = await mountProbe();
    failWrites = new TypeError('Network request failed');

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.sync?.({}).catch((error: unknown) => {
        failure = error;
      });
    });

    // The dashboard's sync control stops spinning, and the persisted
    // reconcile-first row makes the next launch offer the same-key retry
    // instead of re-POSTing blind.
    expect(callsTo('securityAgent.triggerSync')).toBe(1);
    expect(holder.syncPending).toBe(false);
    expect(holder.syncError).toBe(i18n.t('securityAgent.mutations.actionFailed'));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(holder.syncError);
    expect(outbox.writeReconcileFirst).toHaveBeenCalledTimes(1);
    expect(outbox.remove).not.toHaveBeenCalled();
    view.unmount();
    onlineManager.setOnline(true);
  });
});
