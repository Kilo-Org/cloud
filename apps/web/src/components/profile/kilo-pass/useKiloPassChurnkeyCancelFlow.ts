'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { showCancelFlow } from '@/lib/churnkey/loader';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

import { createKiloPassChurnkeyCancelFlow } from './kiloPassChurnkeyCancelFlow';

type KiloPassChurnkeyCancelFlowCoordinator = ReturnType<typeof createKiloPassChurnkeyCancelFlow>;

type UseKiloPassChurnkeyCancelFlowParams = {
  stripeSubscriptionId: string;
  fallbackCancelSubscription: () => void;
  onBeforeOpen?: () => void;
};

export function useKiloPassChurnkeyCancelFlow(params: UseKiloPassChurnkeyCancelFlowParams): {
  openCancelFlow: () => Promise<void>;
  isOpeningCancelFlow: boolean;
} {
  const { stripeSubscriptionId, fallbackCancelSubscription, onBeforeOpen } = params;
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [isOpeningCancelFlow, setIsOpeningCancelFlow] = useState(false);

  const coordinatorRef = useRef<KiloPassChurnkeyCancelFlowCoordinator | null>(null);
  const coordinator = coordinatorRef.current ?? createKiloPassChurnkeyCancelFlow();
  coordinatorRef.current = coordinator;

  const openCancelFlow = useCallback(
    () =>
      coordinator.openCancelFlow({
        stripeSubscriptionId,
        getChurnkeyAuthHash: () => trpcClient.kiloPass.getChurnkeyAuthHash.query(),
        showCancelFlow,
        cancelSubscription: () => trpcClient.kiloPass.cancelSubscription.mutate(),
        invalidateKiloPassState: () =>
          queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() }),
        invalidateKiloPassScheduledChange: () =>
          queryClient.invalidateQueries({
            queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
          }),
        fallbackCancelSubscription,
        confirmFallbackCancel: message => window.confirm(message),
        notifyCancellationScheduled: () => toast('Cancellation scheduled'),
        notifyError: message => toast.error(message),
        onBeforeOpen,
        onInFlightChange: setIsOpeningCancelFlow,
      }),
    [
      coordinator,
      fallbackCancelSubscription,
      onBeforeOpen,
      queryClient,
      stripeSubscriptionId,
      trpc,
      trpcClient,
    ]
  );

  return { openCancelFlow, isOpeningCancelFlow };
}
