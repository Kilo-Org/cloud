import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelReviewMutationFn,
  createManualReviewMutationFn,
  retriggerReviewMutationFn,
} from './use-code-reviews';

const cancelMutateMock = vi.fn();
const retriggerMutateMock = vi.fn();
const personalCreateMutateMock = vi.fn();
const orgCreateMutateMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
  trpcClient: {
    codeReviews: {
      cancel: { mutate: (vars: unknown) => cancelMutateMock(vars) },
      retrigger: { mutate: (vars: unknown) => retriggerMutateMock(vars) },
    },
    personalReviewAgent: {
      createManualReviewJob: { mutate: (vars: unknown) => personalCreateMutateMock(vars) },
    },
    organizations: {
      reviewAgent: {
        createManualReviewJob: { mutate: (vars: unknown) => orgCreateMutateMock(vars) },
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

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

const CREATE_VARS = {
  platform: 'github',
  url: 'https://github.com/foo/bar/pull/1',
  modelSlug: 'claude-opus-4-7',
} as const;

beforeEach(() => {
  cancelMutateMock.mockReset();
  retriggerMutateMock.mockReset();
  personalCreateMutateMock.mockReset();
  orgCreateMutateMock.mockReset();
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
    const successPayload = { success: true, reviewId: 'rev_abc123' };
    personalCreateMutateMock.mockResolvedValue(successPayload);

    await expect(createManualReviewMutationFn('personal', CREATE_VARS)).resolves.toEqual(
      successPayload
    );
  });
});
