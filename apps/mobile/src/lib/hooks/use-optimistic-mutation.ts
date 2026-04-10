import { type QueryClient, type QueryKey } from '@tanstack/react-query';

type OptimisticOpts<TInput, TData extends Record<string, unknown>> = {
  queryClient: QueryClient;
  queryKey: QueryKey;
  updater: (old: TData, input: TInput) => TData;
  settle?: () => Promise<void>;
};

/**
 * Generates `onMutate`, `onError`, and `onSettled` callbacks for
 * optimistic updates with automatic rollback on error.
 */
export function optimisticCallbacks<TInput, TData extends Record<string, unknown>>(
  opts: OptimisticOpts<TInput, TData>
) {
  const { queryClient, queryKey, updater, settle } = opts;
  return {
    onMutate: async (input: TInput) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TData>(queryKey);
      queryClient.setQueryData<TData>(queryKey, old => (old ? updater(old, input) : old));
      return { previous };
    },
    onError: (error: { message: string }, _input: TInput, context?: { previous?: TData }) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      throw new Error(error.message);
    },
    onSettled:
      settle ??
      (async () => {
        await queryClient.invalidateQueries({ queryKey });
      }),
  };
}
