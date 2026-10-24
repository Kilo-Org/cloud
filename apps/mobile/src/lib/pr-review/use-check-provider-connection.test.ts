// Wiring tests for the provider-connection check behind the PR-review
// connect gate. Each platform arm must query its own status procedure with
// the organization the caller already selected, and a Bitbucket personal
// scope has nothing to check: it reports not-connected without a call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable import/first -- the module under test resolves the mocks below */
import {
  type CheckProviderConnectionInput,
  useCheckProviderConnection,
} from './use-check-provider-connection';
/* eslint-enable import/first */

type MutationOptions = {
  mutationFn?: (input: CheckProviderConnectionInput) => Promise<unknown>;
  onError?: (error: Error) => void;
};

let captured: MutationOptions | null = null;
const queryMock = vi.fn();
const invalidateQueries = vi.fn();
const toastError = vi.fn();

function statusQueryOptions(kind: string, input?: unknown) {
  return {
    queryKey: input === undefined ? [kind] : [kind, input],
    queryFn: vi.fn(() => Promise.resolve({ connected: false })),
  };
}

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: MutationOptions) => {
    captured = options;
    return { mutate: vi.fn(), mutateAsync: vi.fn() };
  },
  useQueryClient: () => ({ query: queryMock, invalidateQueries }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: (message: string) => toastError(message) },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      reviewAgent: {
        getGitLabStatus: {
          queryOptions: ({ organizationId }: { organizationId: string }) =>
            statusQueryOptions('org-gitlab', organizationId),
        },
        getBitbucketReadiness: {
          queryOptions: ({ organizationId }: { organizationId: string }) =>
            statusQueryOptions('bitbucket-readiness', organizationId),
        },
      },
    },
    personalReviewAgent: {
      getGitLabStatus: {
        queryOptions: () => statusQueryOptions('personal-gitlab'),
      },
    },
    providerReview: {
      pathFilter: () => ({ queryKey: ['providerReview'] }),
    },
  }),
}));

function capturedMutationFn(): (input: CheckProviderConnectionInput) => Promise<unknown> {
  const fn = captured?.mutationFn;
  if (!fn) {
    throw new Error('the hook did not register a mutationFn');
  }
  return fn;
}

beforeEach(() => {
  captured = null;
  queryMock.mockReset();
  invalidateQueries.mockReset();
  toastError.mockReset();
  useCheckProviderConnection();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCheckProviderConnection', () => {
  it('reports a Bitbucket personal scope as not connected without a query', async () => {
    queryMock.mockResolvedValue({ connected: true });

    await expect(
      capturedMutationFn()({ platform: 'bitbucket', organizationId: null })
    ).resolves.toEqual({
      connected: false,
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('treats an empty Bitbucket organization as the personal scope', async () => {
    await expect(
      capturedMutationFn()({ platform: 'bitbucket', organizationId: '' })
    ).resolves.toEqual({
      connected: false,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('checks the Bitbucket readiness of the selected organization', async () => {
    queryMock.mockResolvedValueOnce({ connected: true });

    await expect(
      capturedMutationFn()({ platform: 'bitbucket', organizationId: 'org-7' })
    ).resolves.toEqual({ connected: true });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['bitbucket-readiness', 'org-7'],
        staleTime: 0,
      })
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['providerReview'] });
  });

  it('keeps the Bitbucket invalidation off a disconnected readiness answer', async () => {
    queryMock.mockResolvedValueOnce({ connected: false });

    await expect(
      capturedMutationFn()({ platform: 'bitbucket', organizationId: 'org-7' })
    ).resolves.toEqual({ connected: false });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('checks the personal GitLab status when no organization is selected', async () => {
    queryMock.mockResolvedValueOnce({ connected: false });

    await expect(
      capturedMutationFn()({ platform: 'gitlab', organizationId: null })
    ).resolves.toEqual({
      connected: false,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['personal-gitlab'], staleTime: 0 })
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('checks the organization GitLab status and invalidates the provider queries', async () => {
    queryMock.mockResolvedValueOnce({ connected: true });

    await expect(
      capturedMutationFn()({ platform: 'gitlab', organizationId: 'org-9' })
    ).resolves.toEqual({
      connected: true,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['org-gitlab', 'org-9'], staleTime: 0 })
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['providerReview'] });
  });

  it('toasts the failure message', () => {
    captured?.onError?.(new Error('bitbucket is down'));
    expect(toastError).toHaveBeenCalledWith('bitbucket is down');
  });
});
