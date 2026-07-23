import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCancelReview, useCreateManualReview, useRetriggerReview } from './use-code-reviews';

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

// Each test calls exactly one of the three hooks. Capture the most recent
// useMutation options — that's the hook under test for that test.
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

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

// hasInFlightReview / isInFlightReviewStatus are only referenced by the
// query hooks' refetchInterval callbacks (useReviewList/useReviewDetail),
// which these tests don't exercise — stub them so the module evaluates.
vi.mock('@kilocode/app-shared/code-review', () => ({
  hasInFlightReview: () => false,
  isInFlightReviewStatus: () => false,
}));

// PERSONAL_SCOPE is re-exported from use-code-reviewer; stub the import
// path the production code uses (the re-export in this file does that for
// callers, but use-code-reviews imports the constant directly). We replace
// the whole module with a stub whose only export is the literal 'personal'
// so isPersonal() inside the hook returns the right value.
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
}));

function getOptions(hook: 'cancel' | 'retrigger' | 'create', scope = 'personal'): MutationOptions {
  // Each hook only calls useMutation once; capturing the last one is enough
  // because every test invokes exactly one hook. Use 'personal' for create
  // by default so the personal-scoped tRPC mock path is exercised unless a
  // test explicitly requests the org path.
  lastCapturedOptions = null;
  if (hook === 'cancel') {
    useCancelReview(scope);
  } else if (hook === 'retrigger') {
    useRetriggerReview(scope);
  } else {
    useCreateManualReview(scope);
  }
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

describe('useCancelReview', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Review cannot be cancelled in its current state.',
    });
    const opts = getOptions('cancel');

    // The thrown error must be a plain Error whose .message is the server's
    // data.error verbatim — useCodeReviewer.ts's pattern uses a generic
    // literal that would regress the user-facing message; this hook keeps
    // the domain reason intact so toast.error(error.message) shows it.
    try {
      await opts.mutationFn?.({ reviewId: 'r1' });
      throw new Error('mutationFn should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Review cannot be cancelled in its current state.');
    }
  });

  it('resolves with the full success payload so the mutation lifecycle continues normally', async () => {
    const successPayload = { success: true, review: { id: 'r1', status: 'cancelled' } };
    cancelMutateMock.mockResolvedValueOnce(successPayload);
    const opts = getOptions('cancel');

    await expect(opts.mutationFn?.({ reviewId: 'r1' })).resolves.toEqual(successPayload);
  });

  it('toasts the thrown error message via onError and does NOT call onSuccess on failure', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Already completed',
    });
    const opts = getOptions('cancel');

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({ reviewId: 'r1' });
    } catch (err) {
      thrown = err;
      opts.onError?.(err);
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Already completed');
    expect(toastErrorMock).toHaveBeenCalledWith('Already completed');
    // onSuccess must not have run on the failure path — that's the live
    // defect the slice fixes (per-call cancel haptic on a failed cancel).
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the review list and detail on real success', () => {
    const opts = getOptions('cancel');
    opts.onSuccess?.({ success: true, review: { id: 'r1' } }, { reviewId: 'r1' });

    // useInvalidateReviews calls invalidateQueries once for the list key
    // and again for the detail key when a reviewId is provided.
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('useRetriggerReview', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Repository not connected',
    });
    const opts = getOptions('retrigger');

    await expect(opts.mutationFn?.({ reviewId: 'r2' })).rejects.toThrow('Repository not connected');
  });

  it('resolves with the full success payload on success', async () => {
    const successPayload = { success: true, review: { id: 'r2', status: 'queued' } };
    retriggerMutateMock.mockResolvedValueOnce(successPayload);
    const opts = getOptions('retrigger');

    await expect(opts.mutationFn?.({ reviewId: 'r2' })).resolves.toEqual(successPayload);
  });

  it('toasts the thrown error message via onError and does NOT call onSuccess on failure', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Provider rate limit hit',
    });
    const opts = getOptions('retrigger');

    try {
      await opts.mutationFn?.({ reviewId: 'r2' });
    } catch (err) {
      opts.onError?.(err);
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

describe('useCreateManualReview', () => {
  it('throws a typed error carrying the server error message on {success:false} (personal scope)', async () => {
    const opts = getOptions('create', 'personal');
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Invalid pull request URL',
    });

    try {
      await opts.mutationFn?.({
        platform: 'github',
        url: 'https://github.com/foo/bar/pull/1',
        modelSlug: 'claude-opus-4-7',
      });
      throw new Error('mutationFn should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Invalid pull request URL');
    }
  });

  it('throws a typed error carrying the server error message on {success:false} (org scope)', async () => {
    const opts = getOptions('create', 'org_42');
    orgCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Provider not connected for organization',
    });

    try {
      await opts.mutationFn?.({
        platform: 'gitlab',
        url: 'https://gitlab.com/g/p/-/merge_requests/1',
        modelSlug: 'claude-opus-4-7',
      });
      throw new Error('mutationFn should have rejected');
    } catch (err) {
      expect((err as Error).message).toBe('Provider not connected for organization');
    }
    expect(orgCreateMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_42' })
    );
  });

  it('resolves with the full success payload (including reviewId) so caller navigation works', async () => {
    const opts = getOptions('create', 'personal');
    const successPayload = { success: true as const, reviewId: 'rev_abc123' };
    personalCreateMutateMock.mockResolvedValue(successPayload);

    const resolved = (await opts.mutationFn?.({
      platform: 'github',
      url: 'https://github.com/foo/bar/pull/1',
      modelSlug: 'claude-opus-4-7',
    })) as { success: true; reviewId: string };

    // The screen destructures `{ reviewId }` from onSuccess's argument to
    // navigate — verify that the payload still carries the full success
    // shape with `reviewId` (the defect the slice fixes was navigating with
    // `reviewId` undefined because the mutationFn used to resolve on
    // {success:false}).
    expect(resolved.reviewId).toBe('rev_abc123');
  });

  it('toasts the thrown error message via onError and does NOT call onSuccess on failure', async () => {
    const opts = getOptions('create', 'personal');
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Insufficient balance',
    });

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({
        platform: 'github',
        url: 'https://github.com/foo/bar/pull/1',
        modelSlug: 'claude-opus-4-7',
      });
    } catch (err) {
      thrown = err;
      opts.onError?.(err);
    }

    expect((thrown as Error).message).toBe('Insufficient balance');
    expect(toastErrorMock).toHaveBeenCalledWith('Insufficient balance');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the list (no detail) on real success', () => {
    const opts = getOptions('create', 'personal');
    opts.onSuccess?.({ success: true, reviewId: 'rev_abc123' }, undefined);

    // useInvalidateReviews with no reviewId only invalidates the list.
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
