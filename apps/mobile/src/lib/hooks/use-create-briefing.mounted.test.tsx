import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import {
  type CreateBriefingState,
  type PreparedBriefing,
  useCreateBriefing,
} from './use-create-briefing';

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

const input = {
  startAt: '2026-10-19T12:00:00.000Z',
  endAt: '2026-10-20T12:00:00.000Z',
  timezone: 'Europe/Belgrade',
  language: 'en',
};
const prepared: PreparedBriefing = {
  report: {
    id: 'report-1',
    kind: 'one_off',
    createdAt: input.endAt,
    timezone: input.timezone,
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    localDate: '2026-10-20',
    nightStartAt: input.startAt,
    cutoffAt: input.endAt,
    morningEndAt: '2026-11-19T12:00:00.000Z',
    publishedAt: null,
    updatedAt: input.endAt,
    revision: 1,
    revised: false,
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 1, pullRequests: 0, blockers: 0, spendMicrodollars: 0 },
    coverage: {
      activity: 'partial',
      spend: 'unavailable',
      blockers: 'partial',
      pullRequests: 'partial',
    },
    sessions: [],
    sources: [],
    summary: {
      status: 'disabled',
      text: null,
      model: null,
      costMicrodollars: 0,
      chargeStatus: 'settled',
      estimatedCostMicrodollars: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      canRetry: false,
    },
    expiresAt: '2026-11-19T12:00:00.000Z',
  },
  estimate: {
    canGenerate: true,
    estimateToken: 'bound-token',
    model: 'test/model',
    estimatedCostMicrodollars: 1,
    maximumCostMicrodollars: 2,
    maxDurationSeconds: 60,
    unavailableReason: null,
  },
};
const published: { current?: CreateBriefingState } = {};
function Harness() {
  published.current = useCreateBriefing();
  return null;
}
function state() {
  if (!published.current) {
    throw new Error('Hook is not mounted');
  }
  return published.current;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(Harness))
    );
  });
  if (!holder.renderer) {
    throw new Error('Renderer is not mounted');
  }
  return { renderer: holder.renderer, client };
}

describe('one-off briefing request state', () => {
  beforeEach(() => {
    mocks.prepare.mockReset();
    mocks.create.mockReset();
    mocks.toast.mockReset();
    mocks.offline = false;
    mocks.nextId = 0;
    published.current = undefined;
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
