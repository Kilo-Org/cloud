'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';

type ModelPreferences = inferRouterOutputs<RootRouter>['modelPreferences']['get'];

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery(
    trpc.modelPreferences.get.queryOptions(organizationId ? { organizationId } : undefined)
  );

  const setLastSelected = useMutation(
    trpc.modelPreferences.setLastSelected.mutationOptions({
      // Partial key (no input) so org-scoped and org-less caches both refresh.
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.modelPreferences.get.queryKey() }),
      onError,
    })
  );

  return {
    lastSelected: query.data?.lastSelected ?? null,
    setLastSelected: setLastSelected.mutate,
  };
}

// Rapid star taps must reach the server in tap order; a shared mutation scope
// serializes add/remove so a slower earlier request cannot stomp a later one.
const FAVORITES_MUTATION_SCOPE = { id: 'model-preferences-favorites' };

export function useModelFavorites(
  organizationId: string | undefined,
  options: { enabled?: boolean } = {}
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  const query = useQuery({
    ...trpc.modelPreferences.get.queryOptions(input),
    enabled: options.enabled ?? true,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.modelPreferences.get.queryKey() });

  const applyOptimisticFavorites = async (update: (favorites: string[]) => string[]) => {
    const queryKey = trpc.modelPreferences.get.queryKey(input);
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<ModelPreferences>(queryKey);
    if (previous) {
      queryClient.setQueryData(queryKey, { ...previous, favorites: update(previous.favorites) });
    }
    return previous;
  };

  const rollbackFavorites = (
    error: { message: string },
    previous: ModelPreferences | undefined
  ) => {
    if (previous) {
      queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), previous);
    }
    onError(error);
  };

  const addFavorite = useMutation(
    trpc.modelPreferences.addFavorite.mutationOptions({
      scope: FAVORITES_MUTATION_SCOPE,
      onMutate: async ({ model }): Promise<ModelPreferences | undefined> =>
        applyOptimisticFavorites(favorites =>
          favorites.includes(model) ? favorites : [...favorites, model]
        ),
      onError: (error, _input, previous) => rollbackFavorites(error, previous),
      onSettled: invalidate,
    })
  );

  const removeFavorite = useMutation(
    trpc.modelPreferences.removeFavorite.mutationOptions({
      scope: FAVORITES_MUTATION_SCOPE,
      onMutate: async ({ model }): Promise<ModelPreferences | undefined> =>
        applyOptimisticFavorites(favorites => favorites.filter(id => id !== model)),
      onError: (error, _input, previous) => rollbackFavorites(error, previous),
      onSettled: invalidate,
    })
  );

  return {
    favorites: query.data?.favorites ?? [],
    addFavorite: addFavorite.mutate,
    removeFavorite: removeFavorite.mutate,
  };
}
