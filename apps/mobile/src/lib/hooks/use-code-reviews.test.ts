import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelReviewMutationFn,
  createManualReviewMutationFn,
  retriggerReviewMutationFn,
  useCancelReview,
  useCreateManualReview,
  useRetriggerReview,
} from './use-code-reviews';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown) => void;
  onError?: (error: unknown) => void;
};

const cancelMutateMock = vi.fn();
const retriggerMutateMock = vi.fn();
const personalCreateMutateMock = vi.fn();
const orgCreateMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const toastErrorMock = vi.fn();

let lastCapturedOptions: MutationOptions | null = null;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn() };
  },
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    cancelQueries: cancelQueriesMock,
    getQueryData: getQueryDataMock,
    setQueryData: setQueryDataMock,
    invalidateQueries: invalidateQueriesMock,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    codeReviews: {
      listForUser: { queryKey: () => ['codeReviews', 'listForUser'] },
      listForOrganization: { queryKey: () => ['codeReviews', 'listForOrganization'] },
      get: { queryKey: () => ['codeReviews', 'get'] },
    },
  }),
  trpcClient: {
    codeReviews: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      cancel: { mutate: (vars: unknown) => cancelMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      retrigger: { mutate: (vars: unknown) => retriggerMutateMock(vars) },
    },
    personalReviewAgent: {
      createManualReviewJob: {
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        mutate: (vars: unknown) => personalCreateMutateMock(vars),
      },
    },
    organizations: {
      reviewAgent: {
        createManualReviewJob: {
          // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
          mutate: (vars: unknown) => orgCreateMutateMock(vars),
        },
      },
    },
  },
}));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
}));

vi.mock('@kilocode/app-shared/code-review', () => ({
  hasInFlightReview: () => false,
  isInFlightReviewStatus: () => false,
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: (msg: string) => toastErrorMock(msg) },
}));

const CREATE_VARS = {
  platform: 'github',
  url: 'https://github.com/foo/bar/pull/1',
  modelSlug: 'claude-opus-4-7',
} as const;

function getOptions(hook: 'cancel' | 'retrigger' | 'create', scope = 'personal'): MutationOptions {
  lastCapturedOptions = null;
  if (hook === 'cancel') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCancelReview(scope);
  } else if (hook === 'retrigger') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRetriggerReview(scope);
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCreateManualReview(scope);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error(`mutation options for ${hook} were not captured`);
  }
  return lastCapturedOptions;
}

beforeEach(() => {
  lastCapturedOptions = null;
  cancelMutateMock.mockReset();
  retriggerMutateMock.mockReset();
  personalCreateMutateMock.mockReset();
  orgCreateMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  getQueryDataMock.mockReset();
  setQueryDataMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cancelReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Review cannot be cancelled in its current state.',
    });

    await expect(cancelReviewMutationFn({ reviewId: 'r1' })).rejects.toThrow(
      'Review cannot be cancelled in its current state.'
    );
  });

  it('resolves with the full success payload so the mutation lifecycle continues normally', async () => {
    const successPayload = { success: true, review: { id: 'r1', status: 'cancelled' } };
    cancelMutateMock.mockResolvedValueOnce(successPayload);

    await expect(cancelReviewMutationFn({ reviewId: 'r1' })).resolves.toEqual(successPayload);
  });
});

describe('useCancelReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Already completed',
    });
    const opts = getOptions('cancel');

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({ reviewId: 'r1' });
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Already completed');
    expect(toastErrorMock).toHaveBeenCalledWith('Already completed');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the review list and detail on real success', () => {
    const opts = getOptions('cancel');
    opts.onSuccess?.({ success: true, review: { id: 'r1' } }, { reviewId: 'r1' });

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('retriggerReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Repository not connected',
    });

    await expect(retriggerReviewMutationFn({ reviewId: 'r2' })).rejects.toThrow(
      'Repository not connected'
    );
  });

  it('resolves with the full success payload on success', async () => {
    const successPayload = { success: true, review: { id: 'r2', status: 'queued' } };
    retriggerMutateMock.mockResolvedValueOnce(successPayload);

    await expect(retriggerReviewMutationFn({ reviewId: 'r2' })).resolves.toEqual(successPayload);
  });
});

describe('useRetriggerReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Provider rate limit hit',
    });
    const opts = getOptions('retrigger');

    try {
      await opts.mutationFn?.({ reviewId: 'r2' });
    } catch (error) {
      opts.onError?.(error);
    }

    expect(toastErrorMock).toHaveBeenCalledWith('Provider rate limit hit');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the review list and detail on real success', () => {
    const opts = getOptions('retrigger');
    opts.onSuccess?.({ success: true }, { reviewId: 'r2' });

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('createManualReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false} (personal scope)', async () => {
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Invalid pull request URL',
    });

    await expect(createManualReviewMutationFn('personal', CREATE_VARS)).rejects.toThrow(
      'Invalid pull request URL'
    );
  });

  it('throws a typed error carrying the server error message on {success:false} (org scope)', async () => {
    orgCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Provider not connected for organization',
    });

    await expect(createManualReviewMutationFn('org_42', CREATE_VARS)).rejects.toThrow(
      'Provider not connected for organization'
    );
    expect(orgCreateMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_42' })
    );
  });

  it('resolves with the full success payload (including reviewId) so caller navigation works', async () => {
    const successPayload = { reviewId: 'rev_abc123', outputMode: 'provider' };
    personalCreateMutateMock.mockResolvedValue(successPayload);

    await expect(createManualReviewMutationFn('personal', CREATE_VARS)).resolves.toEqual(
      successPayload
    );
  });
});

describe('useCreateManualReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    const opts = getOptions('create', 'personal');
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Insufficient balance',
    });

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.(CREATE_VARS);
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect((thrown as Error).message).toBe('Insufficient balance');
    expect(toastErrorMock).toHaveBeenCalledWith('Insufficient balance');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the list (no detail) on real success', () => {
    const opts = getOptions('create', 'personal');
    opts.onSuccess?.({ reviewId: 'rev_abc123', outputMode: 'provider' }, undefined);

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
