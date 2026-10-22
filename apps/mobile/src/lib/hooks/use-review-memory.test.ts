import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSetReviewMemoryEnabled } from './use-review-memory';

const state = vi.hoisted(() => ({
  options: null as {
    mutationFn?: (enabled: boolean) => unknown;
    onSuccess?: (data: { enabled: boolean }) => void;
    onError?: (error: Error) => void;
  } | null,
  queryClient: {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  },
  toast: { error: vi.fn() },
  client: { setEnabled: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => {
    state.options = options as typeof state.options;
    return { mutate: vi.fn() };
  },
  useQueryClient: () => state.queryClient,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { reviewMemory: { setEnabled: { mutate: state.client.setEnabled } } },
  useTRPC: () => ({
    reviewMemory: {
      getDashboardSummary: { queryKey: (input: unknown) => ['reviewMemory.summary', input] },
    },
  }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: state.toast }));

function mount(scope: string) {
  function Probe() {
    useSetReviewMemoryEnabled(scope);
    return null;
  }
  act(() => {
    TestRenderer.create(createElement(Probe));
  });
  if (!state.options) {
    throw new Error('useMutation was not called');
  }
  return state.options;
}

type Summary = { enabled: boolean; repositories: string[]; openProposalCount: number };

beforeEach(() => {
  state.options = null;
  state.queryClient.setQueryData.mockClear();
  state.queryClient.invalidateQueries.mockClear();
  state.toast.error.mockClear();
  state.client.setEnabled.mockClear();
});

describe('useSetReviewMemoryEnabled', () => {
  it('stores the persisted value in the cached summary when the mutation settles', () => {
    const options = mount('personal');

    options.onSuccess?.({ enabled: false });

    expect(state.queryClient.setQueryData).toHaveBeenCalledTimes(1);
    const [key, update] = state.queryClient.setQueryData.mock.calls[0] as [
      unknown,
      (previous: Summary | undefined) => Summary | undefined,
    ];
    expect(key).toEqual(['reviewMemory.summary', { platform: 'github' }]);
    const cached: Summary = { enabled: true, repositories: [], openProposalCount: 2 };
    expect(update(cached)).toEqual({ ...cached, enabled: false });
    expect(update(undefined)).toBeUndefined();
  });

  it('refetches the summary for the same owner after the mutation settles', () => {
    const options = mount('org-1');

    options.onSuccess?.({ enabled: true });

    expect(state.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['reviewMemory.summary', { organizationId: 'org-1', platform: 'github' }],
    });
  });

  it('reports a failed update', () => {
    const options = mount('personal');

    options.onError?.(new Error('nope'));

    expect(state.toast.error).toHaveBeenCalledWith('nope');
  });
});
