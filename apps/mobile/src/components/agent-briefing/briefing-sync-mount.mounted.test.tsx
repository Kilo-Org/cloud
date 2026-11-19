import { type QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BriefingSyncMount } from './briefing-sync-mount';
import { purgeInaccessibleBriefingCache } from '@/lib/agent-briefing-cache';
import { renderWithProviders } from '@/test/render-with-providers';

// The dismissal journal drains one post at a time and backs off on failure. A
// failure that lives only in a ref never re-ran the effect, so the ladder never
// re-armed; these cases walk it with fake timers and prove each step runs.
type JournalEntry = {
  readonly reportId: string;
  readonly organizationId: string | null;
  readonly expiresAt: string;
  readonly synced: boolean;
};

const state = vi.hoisted(() => ({
  dismissals: [] as JournalEntry[],
  client: null as QueryClient | null,
  dismiss: vi.fn<(input: { reportId: string }) => Promise<unknown>>(),
  saveJournal: vi.fn<(entries: JournalEntry[]) => Promise<unknown>>(),
  journalFails: 0,
  toastError: vi.fn(),
}));

vi.mock('sonner-native', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('@/lib/agent-briefing', () => ({
  useBriefingPreferences: () => ({ error: null }),
  useBriefingInvalidation: () => undefined,
  useBriefingDismissals: () => ({
    data: state.dismissals,
    save: { mutateAsync: state.saveJournal, mutate: state.saveJournal, isPending: false },
  }),
}));
vi.mock('@/lib/agent-briefing-cache', () => ({
  purgeInaccessibleBriefingCache: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: 1, isSigningOut: false }),
}));
vi.mock('@/lib/auth/auth-epoch', () => ({ isCurrentAuthEpoch: () => true }));
vi.mock('@/lib/hooks/use-app-lifecycle', () => ({
  useAppLifecycle: () => ({ isActive: true }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({
    isSuccess: true,
    data: [{ organizationId: 'org-1', role: 'admin' }],
  }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      dismiss: {
        mutationOptions: (options: { onError?: () => void }) => ({
          mutationFn: state.dismiss,
          onError: options.onError,
        }),
      },
      list: { pathKey: () => ['agentBriefing', 'list'] },
      pathKey: () => ['agentBriefing'],
    },
  }),
}));

const DISMISSALS_KEY = ['agent-briefing-dismissals', 'user-1'];

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('BriefingSyncMount dismissal drain', () => {
  let unmount: () => void = () => undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.journalFails = 0;
    state.dismiss.mockReset();
    state.saveJournal.mockReset();
    const entry: JournalEntry = {
      reportId: 'report-1',
      organizationId: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      synced: false,
    };
    state.dismissals = [entry];
    state.saveJournal.mockImplementation((entries: JournalEntry[]) => {
      if (state.journalFails > 0) {
        state.journalFails -= 1;
        return Promise.reject(new Error('journal write failed'));
      }
      // The real mutation writes the settled list back into the cache and into
      // the dismissed list the effect reads.
      state.dismissals = entries;
      state.client?.setQueryData(DISMISSALS_KEY, entries);
      return Promise.resolve();
    });

    const mounted = await renderWithProviders(createElement(BriefingSyncMount));
    state.client = mounted.queryClient;
    unmount = mounted.unmount;
    // The reads the drain consults are cache reads.
    state.client.setQueryData(DISMISSALS_KEY, [entry]);
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
  });

  it('walks the finite ladder after repeated server rejections', async () => {
    state.dismiss.mockRejectedValue(new Error('upstream unavailable'));

    await advance(0);
    expect(state.dismiss).toHaveBeenCalledTimes(1);
    expect(state.toastError).toHaveBeenCalledTimes(1);
    // The mount uses the app's real i18n instance (no `@/i18n` mock here), so
    // the toast reads back through the English catalog.
    expect(state.toastError).toHaveBeenCalledWith(
      'Couldn’t dismiss this brief yet. It retries in the background.'
    );

    await advance(2000);
    expect(state.dismiss).toHaveBeenCalledTimes(2);

    await advance(8000);
    expect(state.dismiss).toHaveBeenCalledTimes(3);

    // The ladder is exhausted: no fourth request, however long the app waits.
    await advance(60_000);
    expect(state.dismiss).toHaveBeenCalledTimes(3);
  });

  it('announces each hidden report once, then stays silent for it', async () => {
    const entry = state.dismissals[0];
    if (!entry) {
      throw new Error('Journal entry went missing');
    }
    const second: JournalEntry = { ...entry, reportId: 'report-2' };
    state.dismissals = [entry, second];
    state.client?.setQueryData(DISMISSALS_KEY, [entry, second]);
    // Report-1 exhausts two retries before posting; report-2 then fails.
    state.dismiss
      .mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockResolvedValueOnce({ kind: 'accepted' })
      .mockRejectedValue(new Error('upstream unavailable'));

    await advance(2000);
    expect(state.dismiss).toHaveBeenCalledTimes(2);
    expect(state.toastError).toHaveBeenCalledTimes(1);
    expect(state.toastError).toHaveBeenCalledWith(
      'Couldn’t dismiss this brief yet. It retries in the background.'
    );

    await advance(8000);
    // Report-1 posted on the third step; the settled journal reveals
    // report-2, whose drain runs on the next ladder step.
    expect(state.dismiss).toHaveBeenCalledTimes(3);
    await advance(0);
    await advance(2000);
    expect(state.dismiss).toHaveBeenCalledTimes(4);
    expect(state.toastError).toHaveBeenCalledTimes(2);

    await advance(8000);
    // Report-2 already had its announcement: the retries stay quiet.
    expect(state.toastError).toHaveBeenCalledTimes(2);

    act(() => {
      unmount();
    });
    unmount = () => undefined;
  });

  it('stays silent when the inaccessible-context purge fails', async () => {
    vi.mocked(purgeInaccessibleBriefingCache).mockRejectedValueOnce(
      new Error('cache write failed')
    );
    state.dismiss.mockResolvedValue({ kind: 'accepted' });

    const mountResult = await renderWithProviders(createElement(BriefingSyncMount));
    unmount = mountResult.unmount;
    await advance(0);
    await advance(60_000);
    expect(state.toastError).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });
    unmount = () => undefined;
  });

  it('re-arms the retry after a journal write failure with no other dependency change', async () => {
    state.journalFails = 1;
    state.dismiss.mockResolvedValue({ kind: 'accepted' });

    await advance(0);
    expect(state.dismiss).toHaveBeenCalledTimes(1);
    expect(state.saveJournal).toHaveBeenCalledTimes(1);

    // Nothing else changed: only the failure count can re-arm the 2s step.
    await advance(2000);
    expect(state.dismiss).toHaveBeenCalledTimes(2);
    expect(state.saveJournal).toHaveBeenCalledTimes(2);

    // Posted: the ladder resets and the settled entry is no longer pending.
    await advance(60_000);
    expect(state.dismiss).toHaveBeenCalledTimes(2);
  });
});
