import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { type PreparedBriefing } from './use-create-briefing';
import { draft, input, mount, prepared, state } from './use-create-briefing-test-utils';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
  toast: vi.fn(),
  offline: false,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'request-1' }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toast } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => (mocks.offline ? 'offline' : 'online'),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      startOneOffPreparation: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.prepare }),
      },
      oneOffPreparation: {
        queryOptions: ({ reportId }: { reportId: string }) => ({
          queryKey: ['preparation', reportId],
          queryFn: () => mocks.status(reportId),
        }),
      },
      oneOffDrafts: { pathKey: () => ['briefing-drafts'] },
      createOneOff: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.create }),
      },
      get: { queryKey: ({ reportId }: { reportId: string }) => ['briefing', reportId] },
      list: { pathKey: () => ['briefing-list'] },
    },
  }),
}));

async function waitForReview() {
  await waitFor(() => state().prepared !== null);
  expect(state().prepared).toEqual(prepared);
}

async function review() {
  await act(async () => {
    await state().prepare(input);
  });
  await waitForReview();
}

describe('background briefing auth and connectivity isolation', () => {
  beforeEach(() => {
    bumpAuthEpoch();
    mocks.prepare.mockReset().mockResolvedValue(draft);
    mocks.status.mockReset().mockResolvedValue({ draft: { ...draft, status: 'ready' }, prepared });
    mocks.create.mockReset().mockResolvedValue(prepared.report);
    mocks.toast.mockReset();
    mocks.offline = false;
  });
  it('does not submit offline starts or confirmations', async () => {
    const { renderer, client } = mount();
    mocks.offline = true;
    await act(async () => {
      await state().prepare(input);
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.offline = false;
    await review();
    mocks.offline = true;
    await act(async () => {
      expect(await state().create()).toBeNull();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(state().error).toBe('agentBriefing.createOffline');
    renderer.unmount();
    client.clear();
  });
  it('discards late status results after an account switch', async () => {
    const pending = Promise.withResolvers<{ draft: typeof draft; prepared: PreparedBriefing }>();
    mocks.status.mockReturnValue(pending.promise);
    const { renderer, client } = mount(draft.id);
    await waitFor(() => mocks.status.mock.calls.length > 0);
    bumpAuthEpoch();
    client.clear();
    await act(async () => {
      pending.resolve({ draft, prepared });
      await pending.promise;
    });
    expect(state().prepared).toBeNull();
    expect(await state().create()).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    renderer.unmount();
    client.clear();
  });

  it('does not publish or sign out a new account after an older paid request fails', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    mocks.create.mockReturnValue(pending.promise);
    const signOut = vi.fn<() => void>();
    const restoreHandler = setTrpcUnauthorizedHandler(signOut);
    const { renderer, client } = mount(draft.id);
    try {
      await waitForReview();
      let creating: Promise<PreparedBriefing['report'] | null> | undefined = undefined;
      act(() => {
        creating = state().create();
      });
      await waitFor(() => mocks.create.mock.calls.length > 0);
      bumpAuthEpoch();
      client.clear();
      await act(async () => {
        pending.reject(
          Object.assign(new Error('Expired session'), { data: { authRequired: true } })
        );
        expect(await creating).toBeNull();
      });
      expect(signOut).not.toHaveBeenCalled();
      expect(client.getQueryData(['briefing', draft.id])).toBeUndefined();
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      restoreHandler();
      renderer.unmount();
      client.clear();
    }
  });

  it('does not cache a successful paid confirmation from an earlier account', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    mocks.create.mockReturnValue(pending.promise);
    const { renderer, client } = mount(draft.id);
    await waitForReview();
    let creating: Promise<PreparedBriefing['report'] | null> | undefined = undefined;
    act(() => {
      creating = state().create();
    });
    await waitFor(() => mocks.create.mock.calls.length > 0);
    bumpAuthEpoch();
    client.clear();
    await act(async () => {
      pending.resolve(prepared.report);
      expect(await creating).toBeNull();
    });
    expect(client.getQueryData(['briefing', draft.id])).toBeUndefined();
    renderer.unmount();
    client.clear();
  });
});
