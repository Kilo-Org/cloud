import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useReviewMemoryProposalActions,
  useSetReviewMemoryEnabled,
  useTriggerReviewMemoryAnalysis,
} from '@/lib/hooks/use-review-memory';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

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
// The hooks' error toasts and the permissions hook's router both reach modules
// this node environment cannot load.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: toastSuccess, error: toastError, warning: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useFocusEffect: vi.fn(),
  router: { back: vi.fn() },
}));

const ENABLED_SUCCESS = { enabled: true };
const ANALYSIS_SUCCESS = { status: 'no_pattern' as const };
const PROPOSAL_SUCCESS = {
  id: '9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e',
  status: 'open' as const,
};

const WRITE_PROCEDURES: Record<string, true> = {
  'reviewMemory.setEnabled': true,
  'reviewMemory.triggerAnalysis': true,
  'reviewMemory.updateProposal': true,
  'reviewMemory.rejectProposal': true,
  'reviewMemory.approveAndOpenChangeRequest': true,
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
  setEnabled: ((enabled: boolean) => Promise<unknown>) | null;
  triggerAnalysis: ((repoFullName: string) => Promise<unknown>) | null;
  save:
    | ((
        proposalId: string,
        draft: { title: string; rationale: string; proposedMarkdown: string }
      ) => Promise<unknown>)
    | null;
  reject: ((proposalId: string) => Promise<unknown>) | null;
  approve: ((proposalId: string) => Promise<unknown>) | null;
  isPending: boolean;
  loaded: boolean;
};

/** Mounts all three review-memory write hooks on one probe. */
function HooksProbe({ holder }: { holder: Probe }) {
  holder.setEnabled = useSetReviewMemoryEnabled(PERSONAL_SCOPE).mutateAsync;
  holder.triggerAnalysis = useTriggerReviewMemoryAnalysis(PERSONAL_SCOPE).mutateAsync;
  const actions = useReviewMemoryProposalActions(PERSONAL_SCOPE);
  holder.save = actions.save;
  holder.reject = actions.reject;
  holder.approve = actions.approve;
  holder.isPending = actions.isPending;
  holder.loaded = true;
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

async function mountHooks() {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Probe = {
    setEnabled: null,
    triggerAnalysis: null,
    save: null,
    reject: null,
    approve: null,
    isPending: false,
    loaded: false,
  };
  const view = await renderWithProviders(<HooksProbe holder={holder} />, {
    queryClient,
    wrapper,
  });
  await waitFor(() => holder.loaded);
  return { view, queryClient, holder };
}

function successPayloadFor(procedure: string) {
  if (procedure.endsWith('.setEnabled')) {
    return ENABLED_SUCCESS;
  }
  if (procedure.endsWith('.triggerAnalysis')) {
    return ANALYSIS_SUCCESS;
  }
  return PROPOSAL_SUCCESS;
}

function respondWith(options: { failWrites?: Error } = {}) {
  transport.mockImplementation(async input => {
    await Promise.resolve();
    const procedure = procedureOf(input);
    if (options.failWrites && WRITE_PROCEDURES[procedure] === true) {
      throw options.failWrites;
    }
    return Response.json({ result: { data: successPayloadFor(procedure) } });
  });
}

describe('review memory writes while the device is offline', () => {
  beforeEach(() => {
    queryClientRef.current = null;
    transport.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    onlineManager.setOnline(true);
  });

  it('sends the enable switch instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    await act(async () => {
      await holder.setEnabled?.(true);
    });

    expect(callsTo('reviewMemory.setEnabled')).toBe(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('rejects and toasts when the offline enable switch fails', async () => {
    respondWith({ failWrites: new TypeError('Network request failed') });
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.setEnabled?.(true).catch((error: unknown) => {
        failure = error;
      });
    });

    expect(callsTo('reviewMemory.setEnabled')).toBe(1);
    expect(String(failure)).toContain('Network request failed');
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('sends the analyze run instead of pausing it until the connection returns', async () => {
    respondWith();
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    await act(async () => {
      await holder.triggerAnalysis?.('acme/widgets');
    });
    // The success toast fires in a settled continuation after mutateAsync resolves.
    await act(async () => {
      await Promise.resolve();
    });

    expect(callsTo('reviewMemory.triggerAnalysis')).toBe(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('rejects and toasts when the offline analyze run fails', async () => {
    respondWith({ failWrites: new TypeError('Network request failed') });
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    let failure: unknown = null;
    await act(async () => {
      await holder.triggerAnalysis?.('acme/widgets').catch((error: unknown) => {
        failure = error;
      });
    });

    expect(callsTo('reviewMemory.triggerAnalysis')).toBe(1);
    expect(String(failure)).toContain('Network request failed');
    expect(toastError).toHaveBeenCalledTimes(1);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('sends the proposal actions instead of pausing them until the connection returns', async () => {
    respondWith();
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    await act(async () => {
      await Promise.all([
        holder.save?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e', {
          title: 'T',
          rationale: 'R',
          proposedMarkdown: 'M',
        }),
        holder.reject?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e'),
        holder.approve?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e'),
      ]);
    });

    expect(callsTo('reviewMemory.updateProposal')).toBe(1);
    expect(callsTo('reviewMemory.rejectProposal')).toBe(1);
    expect(callsTo('reviewMemory.approveAndOpenChangeRequest')).toBe(1);
    expect(toastSuccess).toHaveBeenCalledTimes(3);
    expect(holder.isPending).toBe(false);
    view.unmount();
    onlineManager.setOnline(true);
  });

  it('rejects, toasts, and clears the combined pending flag when the offline proposal actions fail', async () => {
    respondWith({ failWrites: new TypeError('Network request failed') });
    const { view, holder } = await mountHooks();

    onlineManager.setOnline(false);
    let failures: unknown[] = [];
    await act(async () => {
      failures = await Promise.all([
        holder.save?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e', {
          title: 'T',
          rationale: 'R',
          proposedMarkdown: 'M',
        }),
        holder.reject?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e'),
        holder.approve?.('9e0f0e5c-1f2a-4c3b-8d4e-5f6a7b8c9d0e'),
      ]).then(
        () => [],
        (error: unknown) => (Array.isArray(error) ? error : [error])
      );
    });

    expect(callsTo('reviewMemory.updateProposal')).toBe(1);
    expect(callsTo('reviewMemory.rejectProposal')).toBe(1);
    expect(callsTo('reviewMemory.approveAndOpenChangeRequest')).toBe(1);
    for (const failure of failures) {
      expect(String(failure)).toContain('Network request failed');
    }
    expect(toastError).toHaveBeenCalledTimes(3);
    // The failure surface this fix guarantees: the controls' combined pending
    // flag returns to false, so a gated control can accept a retry.
    expect(holder.isPending).toBe(false);
    view.unmount();
    onlineManager.setOnline(true);
  });
});
