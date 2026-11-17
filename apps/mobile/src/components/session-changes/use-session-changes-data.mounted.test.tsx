import { createElement } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionChangesData } from '@/components/session-changes/use-session-changes-data';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// The relay answers a refresh that could not reach the worktree with a saved
// snapshot; the hook keeps the higher revision. These cases pin what the banner
// says about that capture: it describes the revision the attempt worked
// against, so a fresher install — in the same response or one that lands while
// the attempt is pending — retires it without another press.
const requests = vi.hoisted(() => ({
  getSession: vi.fn(),
  getWorktreeChanges: vi.fn(),
  refreshWorktreeChanges: vi.fn(),
}));

vi.mock('@/lib/trpc', () => {
  const cloud = {
    getSession: { query: requests.getSession },
    getWorktreeChanges: { query: requests.getWorktreeChanges },
    refreshWorktreeChanges: { mutate: requests.refreshWorktreeChanges },
  };
  return {
    trpcClient: { cloudAgentNext: cloud, organizations: { cloudAgentNext: cloud } },
    useTRPC: () => ({
      cliSessionsV2: {
        get: {
          queryOptions: () => ({
            queryKey: ['cliSessionsV2', 'get'],
            queryFn: () =>
              Promise.resolve({ cloud_agent_session_id: 'ca-1', organization_id: null }),
          }),
        },
        getSessionDiff: {
          queryOptions: () => ({
            queryKey: ['cliSessionsV2', 'diff'],
            queryFn: () => Promise.resolve({ kind: 'files', files: [] }),
          }),
        },
      },
    }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type HookResult = ReturnType<typeof useSessionChangesData>;

function Probe({ holder }: { holder: { current: HookResult | null } }) {
  holder.current = useSessionChangesData('ses-1');
  return null;
}

function current(holder: { current: HookResult | null }): HookResult {
  const value = holder.current;
  if (!value) {
    throw new Error('probe did not render');
  }
  return value;
}

async function mount(): Promise<{ holder: { current: HookResult | null } }> {
  const holder: { current: HookResult | null } = { current: null };
  await renderWithProviders(createElement(Probe, { holder }));
  await waitFor(() => {
    const value = holder.current;
    return value !== null && value.snapshot !== null;
  });
  return { holder };
}

describe('useSessionChangesData refresh failure', () => {
  beforeEach(() => {
    requests.getSession.mockReset();
    requests.getWorktreeChanges.mockReset();
    requests.refreshWorktreeChanges.mockReset();
    requests.getSession.mockResolvedValue({ id: 'ca-1' });
  });

  it('retires the banner when the non-refreshed response carries a newer saved snapshot', async () => {
    requests.getWorktreeChanges.mockResolvedValue({ snapshot: { revision: 1 } });
    requests.refreshWorktreeChanges.mockResolvedValue({
      status: 'failed',
      snapshot: { revision: 5 },
    });

    const { holder } = await mount();
    expect(current(holder).snapshot?.revision).toBe(1);

    await act(async () => {
      current(holder).refresh();
      await Promise.resolve();
    });
    await waitFor(() => current(holder).feedback.status !== 'pending');

    expect(current(holder).snapshot?.revision).toBe(5);
    expect(current(holder).failure).toBeNull();
    expect(current(holder).feedback.status).toBe('idle');
  });

  it('retires the failure a pending attempt published once a newer capture has landed', async () => {
    requests.getWorktreeChanges
      .mockResolvedValueOnce({ snapshot: { revision: 1 } })
      .mockResolvedValue({ snapshot: { revision: 10 } });
    const reply = Promise.withResolvers<{ status: string; snapshot: unknown }>();
    requests.refreshWorktreeChanges.mockReturnValue(reply.promise);

    const { holder } = await mount();
    expect(current(holder).snapshot?.revision).toBe(1);

    await act(async () => {
      current(holder).refresh();
      await Promise.resolve();
    });
    expect(current(holder).feedback.status).toBe('pending');

    // A reconnect capture lands while the attempt is still in flight.
    await act(async () => {
      await current(holder).changesQuery.refetch();
    });
    await waitFor(() => current(holder).snapshot?.revision === 10);

    reply.resolve({ status: 'failed', snapshot: null });
    await waitFor(() => current(holder).feedback.status !== 'pending');

    expect(current(holder).failure).toBeNull();
    // Both captures are the only worktree reads: no further press or capture
    // was needed to retire it.
    expect(requests.getWorktreeChanges).toHaveBeenCalledTimes(2);
  });
});
