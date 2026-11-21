import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RefusalToastModule from '@/lib/refusal-toast';

import { useDismissSecurityFinding } from '@/lib/hooks/use-security-findings';
import { useDeleteFindingsByRepository } from '@/lib/hooks/use-security-orphaned-findings';
import { useStartSecurityRemediation } from '@/lib/hooks/use-security-remediation';
import { announceTrialRefusal } from '@/lib/refusal-toast';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const announceError = vi.hoisted(() => vi.fn());
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
  announcingToast: { success: vi.fn(), error: announceError, warning: vi.fn() },
}));
// The remediation start's own success/refusal toasts are sonner's steps.
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
// The refusal keeps its real body behind a spy: the remediation case asserts the
// hook reached it, and the deletion case still lands on the announcing toast it
// forwards to.
vi.mock('@/lib/refusal-toast', async importOriginal => {
  const actual = await importOriginal<typeof RefusalToastModule>();
  return { ...actual, announceTrialRefusal: vi.fn(actual.announceTrialRefusal) };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  router: { back: vi.fn() },
}));
// The refusal hooks read the reader's role through the organization query
// chain, which pulls the Expo runtime this node project cannot load. These
// cases assert the transport and the failure surfaces, not the role copy.
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => false,
  useOrgBoundary: () => ({ role: undefined }),
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

const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DISMISS_VARS = {
  findingId: FINDING_ID,
  reason: 'tolerable_risk',
  comment: 'retired code',
} as const;

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

type Probe = {
  dismiss: ((vars: typeof DISMISS_VARS) => Promise<unknown>) | null;
  startRemediation: ((vars: { findingId: string }) => Promise<unknown>) | null;
  removeFindings: ((repoFullName: string) => Promise<unknown>) | null;
  dismissPending: boolean;
  remediationPending: boolean;
  removalPending: boolean;
};

/** The three writes a findings surface fires: dismiss, remediate, delete. */
function SecurityWritesProbe({ holder }: { holder: Probe }) {
  const dismiss = useDismissSecurityFinding('personal');
  const startRemediation = useStartSecurityRemediation('personal');
  const removeFindings = useDeleteFindingsByRepository('personal');
  holder.dismiss = dismiss.mutateAsync;
  holder.startRemediation = startRemediation.mutateAsync;
  holder.removeFindings = removeFindings.mutateAsync;
  holder.dismissPending = dismiss.isPending;
  holder.remediationPending = startRemediation.isPending;
  holder.removalPending = removeFindings.isPending;
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

// A transport answer, and a transport failure: the request reached the wire
// and the fetch itself failed, which is what a device with no route sees.
function replyWith(body: unknown) {
  transport.mockImplementation(async () => {
    await Promise.resolve();
    return Response.json({ result: { data: body } });
  });
}

function failWith(error: Error) {
  transport.mockRejectedValue(error);
}

async function mountProbe() {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Probe = {
    dismiss: null,
    startRemediation: null,
    removeFindings: null,
    dismissPending: false,
    remediationPending: false,
    removalPending: false,
  };
  const view = await renderWithProviders(<SecurityWritesProbe holder={holder} />, {
    queryClient,
    wrapper,
  });
  await waitFor(() => holder.dismiss !== null);
  return { view, holder };
}

describe('Security Agent finding writes while the device is offline', () => {
  beforeEach(() => {
    transport.mockReset();
    announceError.mockReset();
    outbox.writeReconcileFirst.mockClear();
    outbox.remove.mockClear();
    vi.mocked(announceTrialRefusal).mockClear();
    onlineManager.setOnline(true);
  });

  it('sends the dismissal instead of pausing it until the connection returns', async () => {
    failWith(new TypeError('Network request failed'));
    const { view, holder } = await mountProbe();

    // NetInfo has committed offline, which pauses a default `networkMode:
    // 'online'` mutation forever: no request, `mutateAsync` never settles, and
    // the dismiss sheet's inline error never renders.
    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.dismiss?.(DISMISS_VARS).catch((error: unknown) => {
        failure = error;
      });
    });

    expect(callsTo('securityAgent.dismissFinding')).toBe(1);
    // The dismissal mapper re-wraps the raw failure on `cause`, so the sheet's
    // error is the transport's own failure, not a request never made.
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toContain('Network request failed');
    await waitFor(() => !holder.dismissPending);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('resolves the offline dismissal with the accepted command instead of queuing it', async () => {
    replyWith({ success: true, commandId: 'cmd-1' });
    const { view, holder } = await mountProbe();

    onlineManager.setOnline(false);
    let result: unknown = null;
    await act(async () => {
      result = await holder.dismiss?.(DISMISS_VARS);
    });

    expect(callsTo('securityAgent.dismissFinding')).toBe(1);
    expect(result).toEqual({ success: true, commandId: 'cmd-1' });
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('settles a refused offline remediation start instead of queuing it', async () => {
    failWith(new Error('Security service is unavailable'));
    const { view, holder } = await mountProbe();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.startRemediation?.({ findingId: FINDING_ID }).catch((error: unknown) => {
        failure = error;
      });
    });

    expect(callsTo('securityAgent.startRemediation')).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    // The refusal toast is the only surface a failed start has, so it ran while
    // the device still reported itself offline.
    expect(vi.mocked(announceTrialRefusal)).toHaveBeenCalledTimes(1);
    await waitFor(() => !holder.remediationPending);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('settles a failed offline repository deletion and announces it once', async () => {
    failWith(new TypeError('Network request failed'));
    const { view, holder } = await mountProbe();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.removeFindings?.('acme/widgets').catch((error: unknown) => {
        failure = error;
      });
    });

    expect(callsTo('securityAgent.deleteFindingsByRepository')).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect(announceError).toHaveBeenCalledTimes(1);
    await waitFor(() => !holder.removalPending);
    view.unmount();
    onlineManager.setOnline(true);
  });
});
