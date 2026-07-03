import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const input = useMemo(() => (organizationId ? { organizationId } : undefined), [organizationId]);

  const query = useQuery(trpc.modelPreferences.get.queryOptions(input));

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.modelPreferences.get.queryKey(input),
    });
  }, [queryClient, trpc.modelPreferences.get, input]);

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
        await queryClient.cancelQueries({ queryKey: trpc.modelPreferences.get.queryKey(input) });
        const previous = queryClient.getQueryData<{
          favorites: string[];
          lastSelected: { model: string; variant?: string } | null;
        }>(trpc.modelPreferences.get.queryKey(input));
        if (previous && !previous.favorites.includes(model)) {
          queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), {
            ...previous,
            favorites: [...previous.favorites, model],
          });
        }
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous) {
          queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), context.previous);
        }
        onError(error);
      },
      onSettled: invalidate,
    })
  );

  const removeFavorite = useMutation(
    trpc.modelPreferences.removeFavorite.mutationOptions({
      onMutate: async ({ model }) => {
        await queryClient.cancelQueries({ queryKey: trpc.modelPreferences.get.queryKey(input) });
        const previous = queryClient.getQueryData<{
          favorites: string[];
          lastSelected: { model: string; variant?: string } | null;
        }>(trpc.modelPreferences.get.queryKey(input));
        if (previous?.favorites.includes(model)) {
          queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), {
            ...previous,
            favorites: previous.favorites.filter(id => id !== model),
          });
        }
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous) {
          queryClient.setQueryData(trpc.modelPreferences.get.queryKey(input), context.previous);
        }
        onError(error);
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
