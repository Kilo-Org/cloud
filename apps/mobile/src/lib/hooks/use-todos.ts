import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { type TodoItem, type TodoList } from '@/lib/todos/todo-types';
import { trpcClient, useTRPC } from '@/lib/trpc';

type TodosInputs = inferRouterInputs<MobileRouter>['todos'];
export type TodoTrpcQueries = {
  todos: { pathFilter: () => Parameters<QueryClient['invalidateQueries']>[0] };
};
type MoveInput = { id: string; beforeId?: string | null; afterId?: string | null };
type UpdateInput = TodosInputs['items']['update'];

/** How long a deleted to-do can be restored before the delete is sent. */
const TODO_UNDO_WINDOW_MS = 5000;

/** Ids of to-dos created optimistically; their rows wait for the server id. */
export const PENDING_TODO_ID_PREFIX = 'pending:';
let pendingTodoSequence = 0;

/** To-dos whose delete is held for the undo toast; the item-list read hides them. */
const heldDeletes = new Set<string>();

function showMutationError(error: { message: string }) {
  toast.error(error.message || i18n.t('common.somethingWentWrong'));
}

export async function invalidateTodoQueries(queryClient: QueryClient, trpc: TodoTrpcQueries) {
  await queryClient.invalidateQueries(trpc.todos.pathFilter());
}

/** Place `id` between the rows that end up directly above and below it. */
function moveRow<T extends { id: string }>(rows: T[], input: MoveInput): T[] {
  const row = rows.find(candidate => candidate.id === input.id);
  if (!row) {
    return rows;
  }
  const rest = rows.filter(candidate => candidate.id !== input.id);
  let index = 0;
  if (input.beforeId) {
    index = rest.findIndex(candidate => candidate.id === input.beforeId) + 1;
  } else if (input.afterId) {
    index = Math.max(
      0,
      rest.findIndex(candidate => candidate.id === input.afterId)
    );
  }
  return [...rest.slice(0, index), row, ...rest.slice(index)];
}

/** A to-do with an update's fields applied; `done` stamps or clears `doneAt`. */
function patchItem<T extends TodoItem>(item: T, { id: _id, done, ...patch }: UpdateInput): T {
  let doneAt = item.doneAt;
  if (done !== undefined) {
    doneAt = done ? new Date().toISOString() : null;
  }
  return { ...item, ...patch, doneAt };
}

/** Open to-dos keep their order; finished ones follow, most recently finished first. */
function orderItems(items: TodoItem[]): TodoItem[] {
  const open = items.filter(item => item.doneAt === null);
  const done = items.filter(item => item.doneAt !== null);
  // `toSorted()` is not available in Hermes.
  // eslint-disable-next-line unicorn/no-array-sort -- in-place sort of a local array
  done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return [...open, ...done];
}

function withoutHeldDeletes(items: TodoItem[]): TodoItem[] {
  return heldDeletes.size === 0 ? items : items.filter(item => !heldDeletes.has(item.id));
}

/** The optimistic write, rollback and reconcile one cached array shares across mutations. */
function useOptimisticArray<TRow>(queryKey: readonly unknown[]) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return function optimistic<TInput>(apply: (rows: TRow[], input: TInput) => TRow[]) {
    return {
      onMutate: async (input: TInput) => {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<TRow[]>(queryKey);
        queryClient.setQueryData<TRow[]>(queryKey, rows => (rows ? apply(rows, input) : rows));
        return { previous };
      },
      onError: (
        error: { message: string },
        _input: TInput,
        context: { previous?: TRow[] } | undefined
      ) => {
        if (context?.previous) {
          queryClient.setQueryData(queryKey, context.previous);
        }
        showMutationError(error);
      },
      onSettled: async () => {
        await invalidateTodoQueries(queryClient, trpc);
      },
    };
  };
}

// ── Lists ─────────────────────────────────────────────────────────────

/** Every list in the context, archived included; the screens split them by `archivedAt`. */
export function useTodoLists(organizationId: string | null, enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.todos.lists.list.queryOptions({ organizationId, includeArchived: true }),
    enabled,
  });
}

export function useTodoListMutations(organizationId: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const optimistic = useOptimisticArray<TodoList>(
    trpc.todos.lists.list.queryKey({ organizationId, includeArchived: true })
  );

  const create = useMutation(
    trpc.todos.lists.create.mutationOptions({
      onError: showMutationError,
      onSettled: async () => {
        await invalidateTodoQueries(queryClient, trpc);
      },
    })
  );
  const update = useMutation(
    trpc.todos.lists.update.mutationOptions(
      optimistic<TodosInputs['lists']['update']>((lists, { id, archived, ...patch }) =>
        lists.map(list => {
          if (list.id !== id) {
            return list;
          }
          let archivedAt = list.archivedAt;
          if (archived !== undefined) {
            archivedAt = archived ? (list.archivedAt ?? new Date().toISOString()) : null;
          }
          return { ...list, ...patch, archivedAt };
        })
      )
    )
  );
  const move = useMutation(trpc.todos.lists.move.mutationOptions(optimistic<MoveInput>(moveRow)));
  const remove = useMutation(
    trpc.todos.lists.delete.mutationOptions(
      optimistic<{ id: string }>((lists, { id }) => lists.filter(list => list.id !== id))
    )
  );

  return { create, update, move, remove };
}

// ── Items ─────────────────────────────────────────────────────────────

export function useTodoItems(listId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.todos.items.list.queryOptions({ listId }),
    select: withoutHeldDeletes,
  });
}

export function useTodoItem(id: string) {
  const trpc = useTRPC();
  return useQuery(trpc.todos.items.get.queryOptions({ id }));
}

export function useUpNextTodos(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.todos.items.upNext.queryOptions({ organizationId, limit: 3 }),
    enabled,
  });
}

export function useSessionTodo(sessionId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.todos.items.forSession.queryOptions({ sessionId }));
}

export function useTodoCandidates(
  sessionId: string,
  organizationId: string | null,
  enabled: boolean
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.todos.items.candidatesForSession.queryOptions({ sessionId, organizationId }),
    enabled,
  });
}

export function useTodoItemMutations(listId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const itemsKey = trpc.todos.items.list.queryKey({ listId });
  const optimistic = useOptimisticArray<TodoItem>(itemsKey);
  const reconcile = {
    onError: showMutationError,
    onSettled: async () => {
      await invalidateTodoQueries(queryClient, trpc);
    },
  };

  const create = useMutation(
    trpc.todos.items.create.mutationOptions(
      optimistic<TodosInputs['items']['create']>((items, input) => {
        pendingTodoSequence += 1;
        const now = new Date().toISOString();
        const pending: TodoItem = {
          id: `${PENDING_TODO_ID_PREFIX}${pendingTodoSequence}`,
          listId: input.listId,
          title: input.title.trim(),
          notes: input.notes ?? null,
          doneAt: null,
          position: '',
          createdAt: now,
          updatedAt: now,
          sessions: [],
        };
        return [pending, ...items];
      })
    )
  );
  const listUpdate = optimistic<UpdateInput>((items, input) =>
    orderItems(items.map(item => (item.id === input.id ? patchItem(item, input) : item)))
  );
  const update = useMutation(
    trpc.todos.items.update.mutationOptions({
      ...listUpdate,
      // The detail screen reads `items.get`, so the same patch lands there too.
      onMutate: async input => {
        const detailKey = trpc.todos.items.get.queryKey({ id: input.id });
        await queryClient.cancelQueries({ queryKey: detailKey });
        const previousDetail = queryClient.getQueryData(detailKey);
        queryClient.setQueryData(detailKey, detail => (detail ? patchItem(detail, input) : detail));
        return { ...(await listUpdate.onMutate(input)), previousDetail };
      },
      onError: (error, input, context) => {
        if (context?.previousDetail) {
          queryClient.setQueryData(
            trpc.todos.items.get.queryKey({ id: input.id }),
            context.previousDetail
          );
        }
        listUpdate.onError(error, input, context);
      },
    })
  );
  const move = useMutation(trpc.todos.items.move.mutationOptions(optimistic<MoveInput>(moveRow)));
  const linkSession = useMutation(trpc.todos.items.linkSession.mutationOptions(reconcile));
  const unlinkSession = useMutation(trpc.todos.items.unlinkSession.mutationOptions(reconcile));

  /**
   * Hide the to-do now and send the delete only once the undo toast expires,
   * so Undo never has to recreate it. The timer is module-owned: leaving the
   * screen still commits the delete. The delete belongs to the account that
   * scheduled it: once that account is gone the request, the failure toast, and
   * the cache refresh are skipped, and the held row is released so the list
   * keeps showing what the server still holds.
   */
  const removeWithUndo = useCallback(
    (item: TodoItem) => {
      heldDeletes.add(item.id);
      const refreshItems = () => {
        queryClient.setQueryData<TodoItem[]>(itemsKey, items => (items ? [...items] : items));
      };
      refreshItems();
      let settled = false;
      const epoch = currentAuthEpoch();
      const isCurrentSession = () => isCurrentAuthEpoch(epoch) && !isSignOutActive();
      const commit = async () => {
        if (!isCurrentSession()) {
          heldDeletes.delete(item.id);
          refreshItems();
          return;
        }
        try {
          await trpcClient.todos.items.delete.mutate({ id: item.id });
        } catch (error) {
          if (isCurrentSession()) {
            showMutationError(
              error instanceof Error ? error : { message: i18n.t('common.somethingWentWrong') }
            );
          }
        } finally {
          heldDeletes.delete(item.id);
          if (isCurrentSession()) {
            await invalidateTodoQueries(queryClient, trpc);
          }
        }
      };
      const timer = setTimeout(() => {
        settled = true;
        void commit();
      }, TODO_UNDO_WINDOW_MS);
      toast(i18n.t('todos.item.deleted'), {
        duration: TODO_UNDO_WINDOW_MS,
        action: {
          label: i18n.t('todos.item.undo'),
          onClick: () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            heldDeletes.delete(item.id);
            refreshItems();
          },
        },
      });
    },
    [itemsKey, queryClient, trpc]
  );

  return { create, update, move, linkSession, unlinkSession, removeWithUndo };
}
