import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner-native';

import { chainSave } from '@/lib/hooks/save-chain';
import { trpcClient, useTRPC } from '@/lib/trpc';

type ModelPreferences = inferRouterOutputs<RootRouter>['modelPreferences']['get'];

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

// Favorites are stored per user (not per organization), so one chain key
// covers every picker instance.
const FAVORITES_CHAIN_KEY = 'model-preferences-favorites';

export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Favorite-toggle failures are surfaced inline in the model picker sheet
  // (the toast layer sits behind it), not via the shared toast `onError`.
  const [favoritesError, setFavoritesError] = useState<string | null>(null);

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
      setFavoritesError(error.message || 'Could not update favorites');
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

  // Rapid favorite taps (add/remove in quick succession) each send a full
  // request; without serializing them, two in-flight requests can resolve
  // out of order and the earlier response can stomp the later one's result.
  // Chaining onto the prior in-flight request keeps them in order — simple
  // FIFO, no dedupe/coalescing (see save-chain.ts).
  const addFavorite = useMutation({
    mutationFn: (vars: { model: string }) =>
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      chainSave(FAVORITES_CHAIN_KEY, () => trpcClient.modelPreferences.addFavorite.mutate(vars)),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onMutate: ({ model }) => {
      setFavoritesError(null);
      return applyOptimisticFavorites(favorites =>
        favorites.includes(model) ? favorites : [...favorites, model]
      );
    },
    onError: (error, _input, context) => {
      rollbackFavorites(error, context);
    },
    onSettled: invalidate,
  });

  const removeFavorite = useMutation({
    mutationFn: (vars: { model: string }) =>
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      chainSave(FAVORITES_CHAIN_KEY, () => trpcClient.modelPreferences.removeFavorite.mutate(vars)),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onMutate: ({ model }) => {
      setFavoritesError(null);
      return applyOptimisticFavorites(favorites => favorites.filter(id => id !== model));
    },
    onError: (error, _input, context) => {
      rollbackFavorites(error, context);
    },
    onSettled: invalidate,
  });

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
    favoritesError,
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
