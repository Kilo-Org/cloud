import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

type ModelPreferences = inferRouterOutputs<RootRouter>['modelPreferences']['get'];

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const input = useMemo(() => (organizationId ? { organizationId } : undefined), [organizationId]);

  const query = useQuery(trpc.modelPreferences.get.queryOptions(input));

  // Partial key (no input) so org-scoped and org-less caches both refresh.
  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.modelPreferences.get.queryKey(),
    });
  }, [queryClient, trpc.modelPreferences.get]);

  const applyOptimisticFavorites = useCallback(
    async (update: (favorites: string[]) => string[]) => {
      const queryKey = trpc.modelPreferences.get.queryKey(input);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ModelPreferences>(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, {
          ...previous,
          favorites: update(previous.favorites),
        });
      }
      return { previous };
    },
    [queryClient, trpc.modelPreferences.get, input]
  );

  const rollbackFavorites = useCallback(
    (error: { message: string }, context: { previous?: ModelPreferences } | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), context.previous);
      }
      onError(error);
    },
    [queryClient, trpc.modelPreferences.get, input]
  );

  const setLastSelected = useMutation(
    trpc.modelPreferences.setLastSelected.mutationOptions({
      onSuccess: invalidate,
      onError,
    })
  );

  const clearLastSelected = useMutation(
    trpc.modelPreferences.clearLastSelected.mutationOptions({
      onSuccess: invalidate,
      onError,
    })
  );

  const addFavorite = useMutation(
    trpc.modelPreferences.addFavorite.mutationOptions({
      onMutate: async ({ model }) => {
        const context = await applyOptimisticFavorites(favorites =>
          favorites.includes(model) ? favorites : [...favorites, model]
        );
        return context;
      },
      onError: (error, _input, context) => {
        rollbackFavorites(error, context);
      },
      onSettled: invalidate,
    })
  );

  const removeFavorite = useMutation(
    trpc.modelPreferences.removeFavorite.mutationOptions({
      onMutate: async ({ model }) => {
        const context = await applyOptimisticFavorites(favorites =>
          favorites.filter(id => id !== model)
        );
        return context;
      },
      onError: (error, _input, context) => {
        rollbackFavorites(error, context);
      },
      onSettled: invalidate,
    })
  );

  const setFavorites = useMutation(
    trpc.modelPreferences.setFavorites.mutationOptions({
      onSuccess: invalidate,
      onError,
    })
  );

  const toggleFavorite = useCallback(
    (model: string) => {
      const isFavorite = query.data?.favorites.includes(model) ?? false;
      if (isFavorite) {
        removeFavorite.mutate({ model });
      } else {
        addFavorite.mutate({ model });
      }
    },
    [query.data?.favorites, addFavorite, removeFavorite]
  );

  return {
    favorites: query.data?.favorites ?? [],
    lastSelected: query.data?.lastSelected ?? null,
    isLoading: query.isLoading,
    setLastSelected: setLastSelected.mutate,
    clearLastSelected: clearLastSelected.mutate,
    addFavorite: addFavorite.mutate,
    removeFavorite: removeFavorite.mutate,
    setFavorites: setFavorites.mutate,
    toggleFavorite,
  };
}
