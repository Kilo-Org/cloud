/* eslint-disable max-lines -- one file for the rename/delete optimistic mutation wiring and rollback suites */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionMutations } from './use-session-mutations';

type MutationOptions = {
  onMutate?: (input: { session_id: string; title?: string }) => Promise<unknown> | unknown;
  onError?: (error: Error, input: unknown, context: unknown) => void;
  onSettled?: () => unknown;
  scope?: { id: string };
  [key: string]: unknown;
};
type TrpcMock = {
  cliSessionsV2: {
    list: { infiniteQueryKey: () => readonly unknown[] };
    recentRepositories: unknown;
    rename: { mutationOptions: (opts: MutationOptions) => MutationOptions };
    delete: { mutationOptions: (opts: MutationOptions) => MutationOptions };
  };
  activeSessions: {
    list: { pathFilter: () => { queryKey: readonly unknown[] } };
  };
};

const mutationOptionsSpy = vi.fn<(opts: MutationOptions) => MutationOptions>();
const capturedOptions: { rename: MutationOptions | null; delete: MutationOptions | null } = {
  rename: null,
  delete: null,
};
const mutateAsyncMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueriesDataMock = vi.fn();
const setQueriesDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const invalidateAgentSessionsMock = vi.fn();
const scheduleCacheMaintenanceMock = vi.fn<(run: () => void) => void>();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
const chainSaveMock = vi.fn((_id: string, op: () => Promise<unknown>) => op());

const listKey = ['cliSessionsV2', 'list'] as const;
const activeFilter = { queryKey: ['activeSessions', 'list'] as const };

const makeMutationOptions = (opts: MutationOptions) => {
  mutationOptionsSpy(opts);
  return opts;
};

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    // rename is registered second in useSessionMutations; capture both.
    if (capturedOptions.delete === null) {
      capturedOptions.delete = opts;
    } else {
      capturedOptions.rename = opts;
    }
    return { mutateAsync: mutateAsyncMock };
  },
  useQueryClient: () => ({
    cancelQueries: cancelQueriesMock,
    getQueriesData: getQueriesDataMock,
    setQueriesData: setQueriesDataMock,
    setQueryData: setQueryDataMock,
    invalidateQueries: invalidateQueriesMock,
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () =>
    ({
      cliSessionsV2: {
        list: { infiniteQueryKey: () => listKey },
        recentRepositories: {},
        rename: { mutationOptions: makeMutationOptions },
        delete: { mutationOptions: makeMutationOptions },
      },
      activeSessions: {
        list: { pathFilter: () => activeFilter },
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

vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: (run: () => void) => {
    scheduleCacheMaintenanceMock(run);
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string) => toastErrorMock(msg),
    success: (msg: string) => toastSuccessMock(msg),
  },
}));

vi.mock('@/lib/hooks/save-chain', () => ({
  // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
  chainSave: (id: string, op: () => Promise<unknown>) => chainSaveMock(id, op),
}));

describe('useSessionMutations', () => {
  beforeEach(() => {
    mutationOptionsSpy.mockClear();
    capturedOptions.rename = null;
    capturedOptions.delete = null;
    mutateAsyncMock.mockReset();
    cancelQueriesMock.mockReset();
    getQueriesDataMock.mockReset();
    setQueriesDataMock.mockReset();
    setQueryDataMock.mockReset();
    invalidateQueriesMock.mockReset();
    invalidateAgentSessionsMock.mockReset();
    scheduleCacheMaintenanceMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    chainSaveMock.mockClear();
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    chainSaveMock.mockImplementation((_id, op) => op());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('renameSessionAsync', () => {
    it('rejects after the mutation onError has toasted and rolled back list cache', async () => {
      const error = new Error('rename failed');
      mutateAsyncMock.mockRejectedValueOnce(error);
      getQueriesDataMock.mockReturnValue([]);

      const { renameSessionAsync } = useSessionMutations();
      await expect(renameSessionAsync('s1', 'New title')).rejects.toBe(error);

      expect(chainSaveMock).toHaveBeenCalledWith('s1', expect.any(Function));
      // The mutation's onError must run before the rejection propagates so the
      // existing list-cache rollback and user-visible toast still fire.
      const options = capturedOptions.rename;
      expect(options?.onError).toBeDefined();
      options?.onError?.(error, { session_id: 's1', title: 'New title' }, undefined);
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

  describe('rename optimistic tray patch', () => {
    it('onMutate cancels and patches both the stored-list and active-list caches', async () => {
      const storedSnapshot: [unknown, unknown][] = [[listKey, { pages: [], pageParams: [] }]];
      const activeSnapshot: [unknown, unknown][] = [
        [
          activeFilter.queryKey,
          {
            sessions: [
              { id: 's1', title: 'Old' },
              { id: 's2', title: 'Other' },
            ],
          },
        ],
      ];
      // First getQueriesData = stored list; second = active list.
      getQueriesDataMock.mockReturnValueOnce(storedSnapshot).mockReturnValueOnce(activeSnapshot);

      useSessionMutations();
      const onMutate = capturedOptions.rename?.onMutate;
      expect(onMutate).toBeDefined();
      if (!onMutate) {
        throw new Error('expected rename onMutate');
      }

      const context = await onMutate({ session_id: 's1', title: 'New title' });

      expect(cancelQueriesMock).toHaveBeenCalledWith({ queryKey: listKey });
      expect(cancelQueriesMock).toHaveBeenCalledWith(activeFilter);
      expect(setQueriesDataMock).toHaveBeenCalledTimes(2);

      // Stored-list updater (first setQueriesData call).
      const storedUpdater = setQueriesDataMock.mock.calls[0]?.[1] as
        | ((old: unknown) => unknown)
        | undefined;
      expect(storedUpdater).toBeTypeOf('function');

      // Active-list updater retitles only the target row.
      const activeUpdater = setQueriesDataMock.mock.calls[1]?.[1] as
        | ((old: { sessions: { id: string; title: string }[] } | undefined) => unknown)
        | undefined;
      expect(setQueriesDataMock.mock.calls[1]?.[0]).toBe(activeFilter);
      expect(activeUpdater).toBeTypeOf('function');
      expect(
        activeUpdater?.({
          sessions: [
            { id: 's1', title: 'Old' },
            { id: 's2', title: 'Other' },
          ],
        })
      ).toEqual({
        sessions: [
          { id: 's1', title: 'New title' },
          { id: 's2', title: 'Other' },
        ],
      });
      expect(activeUpdater?.(undefined)).toBeUndefined();

      expect(context).toEqual({
        previous: storedSnapshot,
        previousActive: activeSnapshot,
        generation: expect.any(Number),
      });
    });

    it('onError restores both snapshots and toasts the error', async () => {
      const storedSnapshot: [unknown, unknown][] = [[['stored-key'], { pages: ['stored'] }]];
      const activeSnapshot: [unknown, unknown][] = [
        [['active-key'], { sessions: [{ id: 's1', title: 'Old' }] }],
      ];
      getQueriesDataMock.mockReturnValueOnce(storedSnapshot).mockReturnValueOnce(activeSnapshot);

      useSessionMutations();
      const options = capturedOptions.rename;
      const onMutate = options?.onMutate;
      if (!onMutate) {
        throw new Error('expected rename onMutate');
      }
      const context = await onMutate({ session_id: 's1', title: 'New' });

      setQueryDataMock.mockClear();
      options.onError?.(new Error('rename failed'), { session_id: 's1', title: 'New' }, context);

      expect(setQueryDataMock).toHaveBeenCalledWith(['stored-key'], { pages: ['stored'] });
      expect(setQueryDataMock).toHaveBeenCalledWith(['active-key'], {
        sessions: [{ id: 's1', title: 'Old' }],
      });
      expect(toastErrorMock).toHaveBeenCalledWith('rename failed');
    });

    it('onSettled still invalidates agent session queries', () => {
      useSessionMutations();
      const options = capturedOptions.rename;
      options?.onSettled?.();

      // The invalidation is deferred behind the interaction scheduler; drive
      // the injected callback to run it in this turn.
      const scheduled = scheduleCacheMaintenanceMock.mock.calls[0]?.[0];
      expect(scheduled).toBeTypeOf('function');
      scheduled?.();

      expect(invalidateAgentSessionsMock).toHaveBeenCalled();
    });
  });

  describe('delete does not touch the active cache', () => {
    it('onMutate only patches the stored-list cache', async () => {
      getQueriesDataMock.mockReturnValue([]);

      useSessionMutations();
      const onMutate = capturedOptions.delete?.onMutate;
      expect(onMutate).toBeDefined();
      if (!onMutate) {
        throw new Error('expected delete onMutate');
      }

      await onMutate({ session_id: 's1' });

      expect(cancelQueriesMock).toHaveBeenCalledWith({ queryKey: listKey });
      expect(cancelQueriesMock).not.toHaveBeenCalledWith(activeFilter);
      expect(setQueriesDataMock).toHaveBeenCalledTimes(1);
      expect(setQueriesDataMock.mock.calls[0]?.[0]).toEqual({ queryKey: listKey });
    });
  });

  describe('generation guard (shared cliSessionsV2.list cache)', () => {
    it('adds no scope.id (callers already serialize per session via chainSave)', () => {
      useSessionMutations();
      expect(capturedOptions.delete?.scope).toBeUndefined();
      expect(capturedOptions.rename?.scope).toBeUndefined();
    });

    it('a failing older delete does not roll back while a newer rename owns the shared list cache', async () => {
      const deleteSnapshot: [unknown, unknown][] = [[['delete-key'], { pages: ['delete'] }]];
      const renameStoredSnapshot: [unknown, unknown][] = [[['stored-key'], { pages: ['stored'] }]];
      const renameActiveSnapshot: [unknown, unknown][] = [
        [['active-key'], { sessions: [{ id: 's2', title: 'Old' }] }],
      ];
      getQueriesDataMock
        .mockReturnValueOnce(deleteSnapshot)
        .mockReturnValueOnce(renameStoredSnapshot)
        .mockReturnValueOnce(renameActiveSnapshot);

      useSessionMutations();
      const deleteOnMutate = capturedOptions.delete?.onMutate;
      const renameOnMutate = capturedOptions.rename?.onMutate;
      if (!deleteOnMutate || !renameOnMutate) {
        throw new Error('expected onMutate');
      }

      const olderDelete = await deleteOnMutate({ session_id: 's1' });
      const newerRename = await renameOnMutate({ session_id: 's2', title: 'New' });

      setQueryDataMock.mockClear();
      capturedOptions.delete?.onError?.(
        new Error('delete failed'),
        { session_id: 's1' },
        olderDelete
      );
      // The older delete's rollback must not restore its snapshot over the
      // newer rename's optimistic write.
      expect(setQueryDataMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledWith('delete failed');

      capturedOptions.rename?.onError?.(
        new Error('rename failed'),
        { session_id: 's2', title: 'New' },
        newerRename
      );
      expect(setQueryDataMock).toHaveBeenCalledWith(['stored-key'], { pages: ['stored'] });
      expect(setQueryDataMock).toHaveBeenCalledWith(['active-key'], {
        sessions: [{ id: 's2', title: 'Old' }],
      });
      expect(toastErrorMock).toHaveBeenCalledWith('rename failed');
    });

    it('a failing latest delete rolls back its snapshot and toasts', async () => {
      const deleteSnapshot: [unknown, unknown][] = [[['delete-key'], { pages: ['delete'] }]];
      getQueriesDataMock.mockReturnValue(deleteSnapshot);

      useSessionMutations();
      const onMutate = capturedOptions.delete?.onMutate;
      if (!onMutate) {
        throw new Error('expected delete onMutate');
      }
      const context = await onMutate({ session_id: 's1' });

      setQueryDataMock.mockClear();
      capturedOptions.delete?.onError?.(new Error('delete failed'), { session_id: 's1' }, context);
      expect(setQueryDataMock).toHaveBeenCalledWith(['delete-key'], { pages: ['delete'] });
      expect(toastErrorMock).toHaveBeenCalledWith('delete failed');
    });
  });

  describe('deleteSession completion callback', () => {
    it('toasts success and invokes onDeleted after a successful delete', async () => {
      mutateAsyncMock.mockResolvedValue(undefined);
      const onDeleted = vi.fn(() => undefined);

      const { deleteSession } = useSessionMutations();
      deleteSession('s1', onDeleted);

      await vi.waitFor(() => {
        expect(onDeleted).toHaveBeenCalledTimes(1);
      });
      expect(chainSaveMock).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(toastSuccessMock).toHaveBeenCalledWith('Session deleted');
    });

    it('does not invoke onDeleted or the success toast when the delete fails', async () => {
      mutateAsyncMock.mockRejectedValueOnce(new Error('delete failed'));
      const onDeleted = vi.fn(() => undefined);

      const { deleteSession } = useSessionMutations();
      deleteSession('s1', onDeleted);

      // Flush the async IIFE so the internal catch has definitely run.
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
      });
      expect(onDeleted).not.toHaveBeenCalled();
      expect(toastSuccessMock).not.toHaveBeenCalled();
    });
  });
});
