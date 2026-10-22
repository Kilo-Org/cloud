import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { chainSave } from '@/lib/hooks/save-chain';
import { trpcClient, useTRPC } from '@/lib/trpc';

type ModelPreferences = inferRouterOutputs<MobileRouter>['modelPreferences']['get'];

const onError = (error: { message: string }) => {
  toast.error(error.message || i18n.t('common.somethingWentWrong'));
};

// Favorites are stored per user (not per organization), so one chain key
// covers every picker instance.
const FAVORITES_CHAIN_KEY = 'model-preferences-favorites';
// Last-selected is per user too, so rapid picks in two org scopes still land in
// the order the user made them.
const LAST_SELECTED_CHAIN_KEY = 'model-preferences-last-selected';

type LastSelectedSelection = { model: string; variant?: string };
/** The cache write this save owns, so an older save's refetch cannot replace it. */
type LastSelectedContext = { generation: number; hash: string };

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
      const generation = nextMutationGeneration(hashKey(queryKey));
      const previous = queryClient.getQueryData<ModelPreferences>(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, {
          ...previous,
          favorites: update(previous.favorites),
        });
      }
      return { previous, generation };
    },
    [queryClient, trpc.modelPreferences.get, input]
  );

  const rollbackFavorites = useCallback(
    (
      error: { message: string },
      context: { previous?: ModelPreferences; generation: number } | undefined
    ) => {
      const queryKey = trpc.modelPreferences.get.queryKey(input);
      if (context?.previous && isLatestMutationGeneration(hashKey(queryKey), context.generation)) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      setFavoritesError(error.message || i18n.t('models.couldNotUpdateFavorites'));
    },
    [queryClient, trpc.modelPreferences.get, input]
  );

  // Reopened forms resolve the server preference before the local saved pick,
  // so an explicit pick is published to this scope's cache immediately. Saves
  // are serialized and the settle-time refetch is generation-fenced: two rapid
  // picks must not let the older save's refetch restore the older model, and
  // must not reach the server out of order.
  const setLastSelected = useMutation({
    ...trpc.modelPreferences.setLastSelected.mutationOptions(),
    // The base settle hook is typed for an absent optimistic context; this
    // mutation owns a generation, and its fenced onSuccess/onError below
    // replace that reconcile.
    onSettled: undefined,
    mutationFn: (selection: LastSelectedSelection) =>
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      chainSave(LAST_SELECTED_CHAIN_KEY, () =>
        trpcClient.modelPreferences.setLastSelected.mutate(selection)
      ),
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onMutate: async (selection: LastSelectedSelection): Promise<LastSelectedContext> => {
      const queryKey = trpc.modelPreferences.get.queryKey(input);
      const hash = hashKey(queryKey);
      const generation = nextMutationGeneration(hash);
      await queryClient.cancelQueries({ queryKey });
      // Update only an already-loaded entry: fabricating one would invent an
      // empty favorites list before the first read settles. Without an entry
      // the pick still resolves from the local preference once the server
      // answer arrives.
      queryClient.setQueryData(queryKey, previous =>
        previous ? { ...previous, lastSelected: selection } : undefined
      );
      return { generation, hash };
    },
    onSuccess: async (_data, _selection, context) => {
      if (!isLatestMutationGeneration(context.hash, context.generation)) {
        return;
      }
      await invalidate();
    },
    onError: error => {
      // Do not refetch here: the server still holds the previous selection,
      // and the model resolves from that cache first, so a failed sync must
      // not silently switch the form back to the older model. The local
      // preference already holds this pick; the toast reports the failure.
      onError(error);
    },
  });

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
  // onError policy: roll back the onMutate snapshot (latest generation only);
  // the caller renders the error inline (no toast).
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
    // onError policy: roll back the onMutate snapshot (latest generation only);
    // the caller renders the error inline (no toast).
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
  };
}
