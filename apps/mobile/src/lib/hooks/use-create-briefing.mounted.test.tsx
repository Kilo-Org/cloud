import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { act } from '@/test/renderer';
import { type PreparedBriefing } from './use-create-briefing';
import { input, mount, prepared, state } from './use-create-briefing-test-utils';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  create: vi.fn(),
  toast: vi.fn(),
  offline: false,
  nextId: 0,
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    mocks.nextId += 1;
    return `request-${mocks.nextId}`;
  },
}));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toast } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => (mocks.offline ? 'offline' : 'online'),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      prepareOneOff: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.prepare }),
      },
      createOneOff: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.create }),
      },
      get: { queryKey: ({ reportId }: { reportId: string }) => ['briefing', reportId] },
      list: { pathKey: () => ['briefing-list'] },
    },
  }),
}));

describe('one-off briefing request state', () => {
  beforeEach(() => {
    bumpAuthEpoch();
    mocks.prepare.mockReset();
    mocks.create.mockReset();
    mocks.toast.mockReset();
    mocks.offline = false;
    mocks.nextId = 0;
  });

  it('coalesces double review taps and keeps the UUID and exact range after a transport failure', async () => {
    mocks.prepare
      .mockRejectedValueOnce(new Error('Transport failed'))
      .mockResolvedValueOnce(prepared);
    const { renderer } = mount();
    await act(async () => {
      await Promise.all([state().prepare(input), state().prepare(input)]);
    });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(state().error).toBe('Transport failed');
    await act(async () => {
      await state().prepare({ ...input, endAt: '2026-10-20T12:10:00.000Z' });
    });
    expect(mocks.prepare.mock.calls[0]?.[0]).toEqual({ ...input, requestId: 'request-1' });
    expect(mocks.prepare.mock.calls[1]?.[0]).toEqual(mocks.prepare.mock.calls[0]?.[0]);
    expect(state().prepared).toEqual(prepared);
    renderer.unmount();
  });

  it('discards late preparation after an edit and allocates a fresh request for the edited input', async () => {
    const pending = Promise.withResolvers<PreparedBriefing>();
    mocks.prepare.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(prepared);
    const { renderer } = mount();
    let reviewing: Promise<void> | undefined = undefined;
    act(() => {
      reviewing = state().prepare(input);
    });
    act(() => {
      state().reset();
    });
    await act(async () => {
      pending.resolve(prepared);
      await reviewing;
    });
    expect(state().prepared).toBeNull();
    expect(await state().create()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => {
      await state().prepare({ ...input, organizationId: 'org-2' });
    });
    expect(mocks.prepare.mock.calls[1]?.[0]).toEqual({
      ...input,
      organizationId: 'org-2',
      requestId: 'request-2',
    });
    renderer.unmount();
  });

  it('never submits offline review or paid confirmation, including after an online review', async () => {
    const { renderer } = mount();
    mocks.offline = true;
    await act(async () => {
      await state().prepare(input);
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.offline = false;
    mocks.prepare.mockResolvedValue(prepared);
    await act(async () => {
      await state().prepare(input);
    });
    mocks.offline = true;
    await act(async () => {
      expect(await state().create()).toBeNull();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(state().error).toBe('agentBriefing.createOffline');
    renderer.unmount();
  });

  it('coalesces concurrent confirmations into one request', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    mocks.prepare.mockResolvedValue(prepared);
    mocks.create.mockReturnValueOnce(pending.promise).mockResolvedValue(prepared.report);
    const { renderer } = mount();
    await act(async () => {
      await state().prepare(input);
    });
    let creating: Promise<PreparedBriefing['report'] | null> | undefined = undefined;
    act(() => {
      creating = state().create();
    });
    expect(await state().create()).toBeNull();
    await act(async () => {
      pending.resolve(prepared.report);
      await creating;
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[0]).toEqual({
      reportId: 'report-1',
      estimateToken: 'bound-token',
    });
    renderer.unmount();
  });

  it('keeps the reviewed report and bound token after an ambiguous create failure', async () => {
    mocks.prepare.mockResolvedValue(prepared);
    mocks.create
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(prepared.report);
    const { renderer } = mount();
    await act(async () => {
      await state().prepare(input);
      await state().create();
    });
    expect(state().prepared).toEqual(prepared);
    expect(state().error).toBe('Connection lost');
    await act(async () => {
      await state().create();
    });
    expect(mocks.create.mock.calls[1]?.[0]).toEqual(mocks.create.mock.calls[0]?.[0]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('does not publish an earlier account’s report after the account changes', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    const started = Promise.withResolvers<undefined>();
    mocks.prepare.mockResolvedValue(prepared);
    mocks.create.mockImplementation(async () => {
      started.resolve(undefined);
      const result = await pending.promise;
      return result;
    });
    const { renderer, client } = mount();
    await act(async () => {
      await state().prepare(input);
    });
    let creating: Promise<PreparedBriefing['report'] | null> | undefined = undefined;
    await act(async () => {
      creating = state().create();
      await started.promise;
    });
    bumpAuthEpoch();
    client.clear();
    let result: PreparedBriefing['report'] | null | undefined = undefined;
    await act(async () => {
      pending.resolve(prepared.report);
      result = await creating;
    });
    expect(result).toBeNull();
    expect(client.getQueryData(['briefing', prepared.report.id])).toBeUndefined();
    renderer.unmount();
  });

  it('discards a review that finishes after the account changes', async () => {
    const pending = Promise.withResolvers<PreparedBriefing>();
    const started = Promise.withResolvers<undefined>();
    mocks.prepare.mockImplementation(async () => {
      started.resolve(undefined);
      const result = await pending.promise;
      return result;
    });
    const { renderer } = mount();
    let reviewing: Promise<void> | undefined = undefined;
    await act(async () => {
      reviewing = state().prepare(input);
      await started.promise;
    });
    bumpAuthEpoch();
    await act(async () => {
      pending.resolve(prepared);
      await reviewing;
    });
    expect(state().prepared).toBeNull();
    expect(await state().create()).toBeNull();
    renderer.unmount();
  });

  it('does not sign out the current account for an earlier account’s failed request', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    const started = Promise.withResolvers<undefined>();
    mocks.prepare.mockResolvedValue(prepared);
    mocks.create.mockImplementation(async () => {
      started.resolve(undefined);
      const result = await pending.promise;
      return result;
    });
    const signOut = vi.fn<() => void>();
    const restoreHandler = setTrpcUnauthorizedHandler(signOut);
    const { renderer } = mount();
    try {
      await act(async () => {
        await state().prepare(input);
      });
      let creating: Promise<PreparedBriefing['report'] | null> | undefined = undefined;
      await act(async () => {
        creating = state().create();
        await started.promise;
      });
      bumpAuthEpoch();
      await act(async () => {
        pending.reject(
          Object.assign(new Error('Expired session'), { data: { authRequired: true } })
        );
        await creating;
      });
      expect(signOut).not.toHaveBeenCalled();
      expect(state().error).toBeNull();
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      restoreHandler();
      renderer.unmount();
    }
  });

  it('blocks unavailable paid estimates and permits empty reports without an estimate token', async () => {
    mocks.prepare.mockResolvedValueOnce({
      ...prepared,
      estimate: { ...prepared.estimate, canGenerate: false },
    });
    const { renderer } = mount();
    await act(async () => {
      await state().prepare(input);
    });
    expect(await state().create()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    act(() => {
      state().reset();
    });
    mocks.prepare.mockResolvedValueOnce({ ...prepared, estimate: null });
    mocks.create.mockResolvedValue(prepared.report);
    await act(async () => {
      await state().prepare(input);
      await state().create();
    });
    expect(mocks.create.mock.calls[0]?.[0]).toEqual({
      reportId: 'report-1',
      estimateToken: undefined,
    });
    renderer.unmount();
  });
});
