import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { type CreateBriefingState, type PreparedBriefing } from './use-create-briefing';
import { draft, input, mount, prepared, state } from './use-create-briefing-test-utils';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
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

describe('background one-off briefing state', () => {
  beforeEach(() => {
    bumpAuthEpoch();
    mocks.prepare.mockReset().mockResolvedValue(draft);
    mocks.status.mockReset().mockResolvedValue({ draft: { ...draft, status: 'ready' }, prepared });
    mocks.create.mockReset().mockResolvedValue(prepared.report);
    mocks.toast.mockReset();
    mocks.offline = false;
    mocks.nextId = 0;
  });

  it('coalesces start taps, returns the persisted draft before collection, and never generates automatically', async () => {
    const pending = Promise.withResolvers<{ draft: typeof draft; prepared: null }>();
    mocks.status.mockReturnValue(pending.promise);
    const { renderer, client } = mount();
    await act(async () => {
      const results = await Promise.all([state().prepare(input), state().prepare(input)]);
      expect(results).toEqual([draft, null]);
    });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(state().prepared).toBeNull();
    expect(await state().create()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    renderer.unmount();
    act(() => {
      pending.resolve({ draft, prepared: null });
    });
    client.clear();
  });

  it('retains the request ID and exact range after an ambiguous transport failure', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Transport failed')).mockResolvedValueOnce(draft);
    const { renderer, client } = mount();
    await act(async () => {
      await state().prepare(input);
    });
    expect(state().error).toBe('agentBriefing.reviewFailed');
    await act(async () => {
      await state().prepare({ ...input, endAt: '2026-10-20T12:10:00.000Z' });
    });
    await waitForReview();
    expect(mocks.prepare.mock.calls[0]?.[0]).toEqual({ ...input, requestId: 'request-1' });
    expect(mocks.prepare.mock.calls[1]?.[0]).toEqual(mocks.prepare.mock.calls[0]?.[0]);
    renderer.unmount();
    client.clear();
  });

  it('resumes a persisted draft on a fresh screen and requires explicit paid confirmation', async () => {
    const first = mount(draft.id);
    await waitForReview();
    first.renderer.unmount();
    first.client.clear();
    const second = mount(draft.id);
    await waitForReview();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => {
      await state().create();
    });
    expect(mocks.create.mock.calls[0]?.[0]).toEqual({
      reportId: draft.id,
      estimateToken: 'bound-token',
    });
    second.renderer.unmount();
    second.client.clear();
  });

  it('discards a late start after a form edit and uses a fresh ID for the edited context', async () => {
    const pending = Promise.withResolvers<typeof draft>();
    mocks.prepare.mockReturnValueOnce(pending.promise);
    const { renderer, client } = mount();
    let starting: Promise<CreateBriefingState['draft']> | undefined = undefined;
    act(() => {
      starting = state().prepare(input);
    });
    act(() => {
      state().reset();
    });
    await act(async () => {
      pending.resolve(draft);
      expect(await starting).toBeNull();
    });
    expect(state().prepared).toBeNull();
    await act(async () => {
      await state().prepare({ ...input, organizationId: 'org-2' });
    });
    expect(mocks.prepare.mock.calls[1]?.[0]).toEqual({
      ...input,
      organizationId: 'org-2',
      requestId: 'request-2',
    });
    renderer.unmount();
    client.clear();
  });

  it('retries a terminal collection failure only on demand and reuses its persisted identity', async () => {
    mocks.status.mockResolvedValue({
      draft: { ...draft, status: 'failed', error: 'time_limit' },
      prepared: null,
    });
    const { renderer, client } = mount(draft.id);
    await waitFor(() => state().draft?.status === 'failed');
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue({ draft: { ...draft, status: 'ready' }, prepared });
    await act(async () => {
      await state().retryPreparation();
    });
    await waitForReview();
    expect(mocks.prepare.mock.calls[0]?.[0]).toEqual({
      ...input,
      organizationId: undefined,
      requestId: draft.id,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    renderer.unmount();
    client.clear();
  });

  it('keeps the reviewed report and bound token after an ambiguous paid confirmation failure', async () => {
    mocks.create
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(prepared.report);
    const { renderer, client } = mount(draft.id);
    await waitForReview();
    await act(async () => {
      await state().create();
    });
    expect(state().prepared).toEqual(prepared);
    expect(state().error).toBe('agentBriefing.createFailed');
    await act(async () => {
      await state().create();
    });
    expect(mocks.create.mock.calls[1]?.[0]).toEqual(mocks.create.mock.calls[0]?.[0]);
    expect(mocks.prepare).not.toHaveBeenCalled();
    renderer.unmount();
    client.clear();
  });

  it('coalesces paid confirmation taps', async () => {
    const pending = Promise.withResolvers<PreparedBriefing['report']>();
    mocks.create.mockReturnValue(pending.promise);
    const { renderer, client } = mount(draft.id);
    await waitForReview();
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
    renderer.unmount();
    client.clear();
  });

  it('blocks unavailable paid estimates and permits empty reports without an estimate token', async () => {
    mocks.status.mockResolvedValue({
      draft: { ...draft, status: 'ready' },
      prepared: { ...prepared, estimate: { ...prepared.estimate, canGenerate: false } },
    });
    const { renderer, client } = mount(draft.id);
    await waitFor(() => state().prepared?.estimate?.canGenerate === false);
    expect(await state().create()).toBeNull();
    mocks.status.mockResolvedValue({
      draft: { ...draft, status: 'ready' },
      prepared: { ...prepared, estimate: null },
    });
    await act(async () => {
      await state().refresh();
    });
    await waitFor(() => state().prepared !== null && state().prepared?.estimate === null);
    await act(async () => {
      await state().create();
    });
    expect(mocks.create.mock.calls[0]?.[0]).toEqual({
      reportId: draft.id,
      estimateToken: undefined,
    });
    renderer.unmount();
    client.clear();
  });
});
