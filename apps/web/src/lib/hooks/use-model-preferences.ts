'use client';

import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import type { RootRouter } from '@/routers/root-router';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
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

const EMPTY_FAVORITES: string[] = [];

type FavoritesMutationContext = {
  previous: ModelPreferences | undefined;
  generation: number;
};

// Favorites are per-user, not per-organization: the read stays org-less so
// CLI-catalog (`remote:`) keys survive and stars match the mobile picker,
// which reads the same store without an organization.
export function useModelFavorites(options: { enabled?: boolean } = {}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...trpc.modelPreferences.get.queryOptions(undefined),
    enabled: options.enabled ?? true,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.modelPreferences.get.queryKey() });

  const applyOptimisticFavorites = async (
    update: (favorites: string[]) => string[]
  ): Promise<FavoritesMutationContext> => {
    const queryKey = trpc.modelPreferences.get.queryKey(undefined);
    await queryClient.cancelQueries({ queryKey });
    const generation = nextMutationGeneration(hashKey(queryKey));
    const previous = queryClient.getQueryData<ModelPreferences>(queryKey);
    if (previous) {
      queryClient.setQueryData(queryKey, { ...previous, favorites: update(previous.favorites) });
    }
    return { previous, generation };
  };

  const rollbackFavorites = (
    error: { message: string },
    context: FavoritesMutationContext | undefined
  ) => {
    const queryKey = trpc.modelPreferences.get.queryKey(undefined);
    if (context?.previous && isLatestMutationGeneration(hashKey(queryKey), context.generation)) {
      queryClient.setQueryData(queryKey, context.previous);
    }
    onError(error);
  };

  const addFavorite = useMutation(
    trpc.modelPreferences.addFavorite.mutationOptions({
      scope: FAVORITES_MUTATION_SCOPE,
      onMutate: ({ model }) =>
        applyOptimisticFavorites(favorites =>
          favorites.includes(model) ? favorites : [...favorites, model]
        ),
      onError: (error, _input, context) => rollbackFavorites(error, context),
      onSettled: invalidate,
    })
  );

  const removeFavorite = useMutation(
    trpc.modelPreferences.removeFavorite.mutationOptions({
      scope: FAVORITES_MUTATION_SCOPE,
      onMutate: ({ model }) =>
        applyOptimisticFavorites(favorites => favorites.filter(id => id !== model)),
      onError: (error, _input, context) => rollbackFavorites(error, context),
      onSettled: invalidate,
    })
  );

  return {
    favorites: query.data?.favorites ?? EMPTY_FAVORITES,
    addFavorite: addFavorite.mutate,
    removeFavorite: removeFavorite.mutate,
  };
}
