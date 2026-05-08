'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc/utils';

/**
 * Returns a stable callback that invalidates every query keyed off a KiloClaw
 * instance's billing/subscription state. Both the `/claw` dashboard card and
 * the `/subscriptions/kiloclaw/:id` detail page need the exact same set of
 * invalidations after a state-changing mutation; centralising them here keeps
 * the two surfaces from drifting.
 */
export function useInvalidateKiloClawBilling(instanceId: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useCallback(async () => {
    if (!instanceId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getActivePersonalBillingStatus.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getPersonalBillingSummary.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.listPersonalSubscriptions.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getSubscriptionDetail.queryKey({ instanceId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getBillingHistory.queryKey({ instanceId }),
      }),
    ]);
  }, [queryClient, trpc, instanceId]);
}
