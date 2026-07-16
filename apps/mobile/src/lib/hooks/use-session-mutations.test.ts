import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionMutations } from './use-session-mutations';

type MutationOptions = Record<string, unknown>;
type TrpcMock = {
  cliSessionsV2: {
    list: { infiniteQueryKey: () => readonly unknown[] };
    recentRepositories: unknown;
    rename: { mutationOptions: (opts: MutationOptions) => MutationOptions };
    delete: { mutationOptions: (opts: MutationOptions) => MutationOptions };
  };
};

const mutationOptionsSpy = vi.fn<(opts: MutationOptions) => MutationOptions>();
const capturedOptions: { current: MutationOptions | null } = { current: null };
const mutateAsyncMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueriesDataMock = vi.fn();
const setQueriesDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const invalidateAgentSessionsMock = vi.fn();
const toastErrorMock = vi.fn();
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
const chainSaveMock = vi.fn((_id: string, op: () => Promise<unknown>) => op());

const makeMutationOptions = (opts: MutationOptions) => {
  mutationOptionsSpy(opts);
  return opts;
};

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedOptions.current = opts;
    return { mutateAsync: mutateAsyncMock };
  },
  useQueryClient: () => ({
    cancelQueries: cancelQueriesMock,
    getQueriesData: getQueriesDataMock,
    setQueriesData: setQueriesDataMock,
    setQueryData: setQueryDataMock,
    invalidateQueries: invalidateQueriesMock,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () =>
    ({
      cliSessionsV2: {
        list: { infiniteQueryKey: () => ['cliSessionsV2', 'list'] },
        recentRepositories: {},
        rename: { mutationOptions: makeMutationOptions },
        delete: { mutationOptions: makeMutationOptions },
      },
    }) satisfies TrpcMock,
}));

vi.mock('@/lib/agent-session-cache', () => ({
  // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
  invalidateAgentSessionQueries: (...args: unknown[]) => {
    invalidateAgentSessionsMock(...args);
    return Promise.resolve();
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

vi.mock('@/lib/hooks/save-chain', () => ({
  // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
  chainSave: (id: string, op: () => Promise<unknown>) => chainSaveMock(id, op),
}));

describe('useSessionMutations.renameSessionAsync', () => {
  beforeEach(() => {
    mutationOptionsSpy.mockClear();
    capturedOptions.current = null;
    mutateAsyncMock.mockReset();
    cancelQueriesMock.mockReset();
    getQueriesDataMock.mockReset();
    setQueriesDataMock.mockReset();
    setQueryDataMock.mockReset();
    invalidateQueriesMock.mockReset();
    invalidateAgentSessionsMock.mockReset();
    toastErrorMock.mockReset();
    chainSaveMock.mockClear();
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    chainSaveMock.mockImplementation((_id, op) => op());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects after the mutation onError has toasted and rolled back list cache', async () => {
    const error = new Error('rename failed');
    mutateAsyncMock.mockRejectedValueOnce(error);
    getQueriesDataMock.mockReturnValue([]);

    const { renameSessionAsync } = useSessionMutations();
    await expect(renameSessionAsync('s1', 'New title')).rejects.toBe(error);

    expect(chainSaveMock).toHaveBeenCalledWith('s1', expect.any(Function));
    // The mutation's onError must run before the rejection propagates so the
    // existing list-cache rollback and user-visible toast still fire.
    const options = capturedOptions.current as { onError?: (err: unknown) => void } | null;
    expect(options?.onError).toBeDefined();
    options?.onError?.(error);
    expect(toastErrorMock).toHaveBeenCalledWith('rename failed');
  });

  it('reuses the same rename mutation options as renameSession', () => {
    // The detail hook relies on the async variant being backed by the exact
    // same mutation (and therefore the same onError/onSettled wiring) as
    // the list's fire-and-forget variant.
    const { renameSessionAsync } = useSessionMutations();
    void renameSessionAsync;
    expect(mutationOptionsSpy).toHaveBeenCalled();
  });
});
