import { type ComponentType, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-review';
import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

import { useReviewMemoryProposalActions, useSetReviewMemoryEnabled } from './use-review-memory';

type ToastStepOptions = { action?: { label: string; onClick: () => void } };

const state = vi.hoisted(() => ({
  options: null as {
    mutationFn?: (enabled: boolean) => unknown;
    onSuccess?: (data: { enabled: boolean }) => void;
    onError?: (error: Error) => void;
  } | null,
  role: 'member' as string | undefined,
  push: vi.fn(),
  queryClient: {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  },
  toast: { error: vi.fn<(message: string, options?: ToastStepOptions) => void>() },
  client: { setEnabled: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => {
    state.options = options as typeof state.options;
    return { mutate: vi.fn() };
  },
  useQueryClient: () => state.queryClient,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));

// Role resolution reads the membership list; only that list and the persisted
// selection are faked, so the real role predicate decides the copy.
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({
    data: [{ organizationId: 'org-1', role: state.role }],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { reviewMemory: { setEnabled: { mutate: state.client.setEnabled } } },
  useTRPC: () => ({
    reviewMemory: {
      getDashboardSummary: { queryKey: (input: unknown) => ['reviewMemory.summary', input] },
      listProposalsPage: { pathKey: () => ['reviewMemory.proposals'] },
      updateProposal: {
        mutationOptions: (options: object) => ({ mutationFn: vi.fn(), ...options }),
      },
      rejectProposal: {
        mutationOptions: (options: object) => ({ mutationFn: vi.fn(), ...options }),
      },
      approveAndOpenChangeRequest: {
        mutationOptions: (options: object) => ({ mutationFn: vi.fn(), ...options }),
      },
    },
  }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: state.toast }));

// `state.options` is reset by `beforeEach`, not here: assigning `null` in this
// function narrows the property to `null` for the rest of it, and TypeScript
// does not see the assignment the mocked hook makes inside `act`.
function mountHook(Probe: ComponentType) {
  act(() => {
    TestRenderer.create(createElement(Probe));
  });
  const options = state.options;
  if (options === null) {
    throw new Error('useMutation was not called');
  }
  return options;
}

function mount(scope: string) {
  function Probe() {
    useSetReviewMemoryEnabled(scope);
    return null;
  }
  return mountHook(Probe);
}

function mountProposalActions(scope: string) {
  function Probe() {
    useReviewMemoryProposalActions(scope);
    return null;
  }
  return mountHook(Probe);
}

/** The sonner step the last toast carried, if it carried one. */
function lastToastStep(): ToastStepOptions | undefined {
  const call = state.toast.error.mock.calls.at(-1);
  if (!call) {
    throw new Error('No error toast was shown');
  }
  return call[1];
}

/** A rejected mutation carrying one server sentence, as tRPC delivers it. */
function rejection(sentence: string): Error {
  return Object.assign(new Error(sentence), {
    data: { code: 'FORBIDDEN', message: sentence },
  });
}

type Summary = { enabled: boolean; repositories: string[]; openProposalCount: number };

beforeEach(() => {
  state.options = null;
  state.role = 'member';
  state.push.mockClear();
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

  it('reports a failed update with localized copy, never the server sentence', () => {
    const options = mount('personal');

    options.onError?.(new Error('nope'));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
  });

  it('explains a known rejection with its own copy', () => {
    const options = mount('personal');
    const sentence = REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.review_memory_disabled;

    options.onError?.(rejection(sentence));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('codeReviewer.reviewMemory.offAction'));
  });

  it('offers a billing role the plan copy and the step to the billing screen', () => {
    state.role = 'owner';
    const options = mount('org-1');

    options.onError?.(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBilling'), {
      action: { label: i18n.t('organization.hub.manageBilling'), onClick: expect.any(Function) },
    });
    lastToastStep()?.action?.onClick();
    expect(state.push).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/organization/billing?org=org-1'
    );
  });

  it('keeps the owner-naming copy and adds no step for a member', () => {
    state.role = 'member';
    const options = mount('org-1');

    options.onError?.(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('common.organizationTrialEnded'));
    expect(state.toast.error.mock.calls[0]).toHaveLength(1);
  });

  it('adds no step to a refusal that is not the trial gate, even for a billing role', () => {
    state.role = 'admin';
    const options = mount('org-1');

    options.onError?.(
      rejection(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.change_request_in_progress)
    );

    expect(state.toast.error).toHaveBeenCalledWith(
      i18n.t('codeReviewer.reviewMemory.changeRequestInProgress')
    );
    expect(state.toast.error.mock.calls[0]).toHaveLength(1);
  });
});

describe('useReviewMemoryProposalActions', () => {
  it('offers a billing role the plan copy and the step when the organization trial has lapsed', () => {
    state.role = 'billing_manager';
    const options = mountProposalActions('org-1');

    options.onError?.(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBilling'), {
      action: { label: i18n.t('organization.hub.manageBilling'), onClick: expect.any(Function) },
    });
  });

  it('keeps the owner-naming copy and adds no step for a member', () => {
    state.role = 'member';
    const options = mountProposalActions('org-1');

    options.onError?.(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE));

    expect(state.toast.error).toHaveBeenCalledWith(i18n.t('common.organizationTrialEnded'));
    expect(state.toast.error.mock.calls[0]).toHaveLength(1);
  });
});
