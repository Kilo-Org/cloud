'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';

type LastSelected = { model: string; variant?: string };

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const input = useMemo(() => (organizationId ? { organizationId } : undefined), [organizationId]);

  const queryKey = useMemo(
    () => trpc.modelPreferences.get.queryKey(input),
    [trpc.modelPreferences.get, input]
  );

  const query = useQuery(trpc.modelPreferences.get.queryOptions(input));

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

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
      onSuccess: invalidate,
      onError,
    })
  );

  const removeFavorite = useMutation(
    trpc.modelPreferences.removeFavorite.mutationOptions({
      onSuccess: invalidate,
      onError,
    })
  );

  const setFavorites = useMutation(
    trpc.modelPreferences.setFavorites.mutationOptions({
      onSuccess: invalidate,
      onError,
    })
  );

  return {
    favorites: query.data?.favorites ?? [],
    lastSelected: (query.data?.lastSelected ?? null) as LastSelected | null,
    isLoading: query.isLoading,
    setLastSelected: setLastSelected.mutate,
    clearLastSelected: clearLastSelected.mutate,
    addFavorite: addFavorite.mutate,
    removeFavorite: removeFavorite.mutate,
    setFavorites: setFavorites.mutate,
  };
}
