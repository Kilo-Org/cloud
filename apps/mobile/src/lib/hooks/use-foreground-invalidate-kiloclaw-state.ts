import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useTRPC } from '@/lib/trpc';

/**
 * Invalidates KiloClaw onboarding / instance / gateway queries on foreground
 * resume (isActive transition false -> true) so the UI reconciles from server
 * state after the app has been backgrounded (e.g. across a long provision or
 * an out-of-band activation on web).
 *
 * `getBillingStatus` is invalidated because the mobile onboarding state is
 * derived from it client-side (see `derive-mobile-onboarding-state`); the
 * derivation recomputes automatically once the billing query refreshes.
 * The server remains the source of truth — we fetch the latest billing row,
 * we never locally flip access.
 *
 * Named after its scope rather than a single consumer because both the tab
 * root and onboarding route call it.
 */
export function useForegroundInvalidateKiloclawState() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    if (!wasActiveRef.current && isActive) {
      void queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.listAllInstances.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getStatus.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
      });
    }
    wasActiveRef.current = isActive;
  }, [
    isActive,
    queryClient,
    trpc.kiloclaw.gatewayStatus,
    trpc.kiloclaw.getBillingStatus,
    trpc.kiloclaw.getStatus,
    trpc.kiloclaw.listAllInstances,
  ]);
}
