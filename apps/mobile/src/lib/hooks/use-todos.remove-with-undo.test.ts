import type * as ReactQuery from '@tanstack/react-query';
import type * as React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { type TodoItem } from '@/lib/todos/todo-types';

import { useTodoItemMutations, useTodoItems } from './use-todos';

// The undo window of useTodoItemMutations.removeWithUndo: the held delete runs
// after five seconds, and only while the account that scheduled it is current.

const TODO_UNDO_WINDOW_MS = 5000;

const { LIST_ID, PATH_FILTER, ITEMS_KEY, deleteRpc, errors, notices, toastMock } = vi.hoisted(
  () => {
    const listId = 'list-1';
    const noticeLog: string[] = [];
    const errorLog: string[] = [];
    const record = (message: string) => {
      noticeLog.push(message);
    };
    return {
      LIST_ID: listId,
      PATH_FILTER: { queryKey: [['todos']] },
      ITEMS_KEY: [['todos', 'items', 'list'], { listId }],
      deleteRpc: vi.fn(),
      errors: errorLog,
      notices: noticeLog,
      toastMock: Object.assign(record, {
        error: (message: string) => {
          errorLog.push(message);
        },
      }),
    };
  }
);

let client = new QueryClient();

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return { ...actual, useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQueryClient: () => client,
    useMutation: () => ({}),
    // The list read applies its `select` to the cached rows, as React Query does.
    useQuery: (options: {
      queryKey: readonly unknown[];
      select?: (rows: TodoItem[]) => TodoItem[];
    }) => {
      const rows = client.getQueryData<TodoItem[]>(options.queryKey) ?? [];
      return { data: options.select ? options.select(rows) : rows };
    },
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    todos: {
      pathFilter: () => PATH_FILTER,
      items: {
        list: {
          queryKey: () => ITEMS_KEY,
          queryOptions: () => ({ queryKey: ITEMS_KEY }),
        },
        create: { mutationOptions: (options: unknown) => options },
        update: { mutationOptions: (options: unknown) => options },
        get: { queryKey: ({ id }: { id: string }) => [['todos', 'items', 'get'], { id }] },
        move: { mutationOptions: (options: unknown) => options },
        linkSession: { mutationOptions: (options: unknown) => options },
        unlinkSession: { mutationOptions: (options: unknown) => options },
      },
    },
  }),
  trpcClient: { todos: { items: { delete: { mutate: deleteRpc } } } },
}));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

function todo(id: string): TodoItem {
  return {
    id,
    listId: LIST_ID,
    title: id,
    notes: null,
    doneAt: null,
    position: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessions: [],
  };
}

function seed(item: TodoItem) {
  client.setQueryData<TodoItem[]>(ITEMS_KEY, [item]);
}

/** The rows the list screen renders: the cached data through the held-delete select. */
function useVisibleTodos(): TodoItem[] {
  return useTodoItems(LIST_ID).data ?? [];
}

function isInvalidated() {
  return client.getQueryCache().find({ queryKey: ITEMS_KEY, exact: true })?.state.isInvalidated;
}

beforeEach(() => {
  vi.useFakeTimers();
  setSignOutActive(false);
  client = new QueryClient();
  deleteRpc.mockReset().mockResolvedValue(undefined);
  errors.length = 0;
  notices.length = 0;
});
afterEach(() => {
  client.clear();
  setSignOutActive(false);
  vi.useRealTimers();
});

describe('removeWithUndo commit', () => {
  it('sends the delete and refreshes the lists when the window ends in the same account', async () => {
    const item = todo('todo-1');
    seed(item);
    const { removeWithUndo } = useTodoItemMutations(LIST_ID);

    removeWithUndo(item);
    expect(notices).toEqual(['todos.item.deleted']);
    // The row is held for the undo toast, so the list hides it meanwhile.
    expect(useVisibleTodos()).toEqual([]);
    expect(deleteRpc).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TODO_UNDO_WINDOW_MS);

    expect(deleteRpc).toHaveBeenCalledTimes(1);
    expect(deleteRpc.mock.calls[0]?.[0]).toEqual({ id: 'todo-1' });
    expect(isInvalidated()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps the to-do and leaves the cache untouched when sign-out lands in the window', async () => {
    const item = todo('todo-2');
    seed(item);
    const { removeWithUndo } = useTodoItemMutations(LIST_ID);

    removeWithUndo(item);
    expect(useVisibleTodos()).toEqual([]);
    setSignOutActive(true);
    await vi.advanceTimersByTimeAsync(TODO_UNDO_WINDOW_MS);

    expect(deleteRpc).not.toHaveBeenCalled();
    expect(isInvalidated()).toBe(false);
    expect(errors).toEqual([]);
    // The delete was skipped, so the held row is released and listed again.
    expect(useVisibleTodos()).toEqual([item]);
  });

  it('keeps the to-do when another account replaced this one in the window', async () => {
    const item = todo('todo-3');
    seed(item);
    const { removeWithUndo } = useTodoItemMutations(LIST_ID);

    removeWithUndo(item);
    bumpAuthEpoch();
    await vi.advanceTimersByTimeAsync(TODO_UNDO_WINDOW_MS);

    expect(deleteRpc).not.toHaveBeenCalled();
    expect(isInvalidated()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('drops the failure toast and the refresh when sign-out lands during the request', async () => {
    const item = todo('todo-4');
    seed(item);
    const request = Promise.withResolvers<undefined>();
    deleteRpc.mockReturnValue(request.promise);
    const { removeWithUndo } = useTodoItemMutations(LIST_ID);

    removeWithUndo(item);
    await vi.advanceTimersByTimeAsync(TODO_UNDO_WINDOW_MS);
    expect(deleteRpc).toHaveBeenCalledTimes(1);

    setSignOutActive(true);
    request.reject(new Error('Network request failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(isInvalidated()).toBe(false);
  });
});
