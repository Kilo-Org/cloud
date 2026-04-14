'use client';

import { createContext, createElement, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { showCancelFlow } from '@/lib/churnkey/loader';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

import { createKiloPassChurnkeyCancelFlow } from './kiloPassChurnkeyCancelFlow';

type KiloPassChurnkeyCancelFlowCoordinator = ReturnType<typeof createKiloPassChurnkeyCancelFlow>;

type KiloPassChurnkeyCancelFlowContextValue = {
  coordinator: KiloPassChurnkeyCancelFlowCoordinator;
  isOpeningCancelFlow: boolean;
  setIsOpeningCancelFlow: (isOpeningCancelFlow: boolean) => void;
};

const KiloPassChurnkeyCancelFlowContext =
  createContext<KiloPassChurnkeyCancelFlowContextValue | null>(null);

type UseKiloPassChurnkeyCancelFlowParams = {
  stripeSubscriptionId: string;
  fallbackCancelSubscription: () => void;
  onBeforeOpen?: () => void;
};

export function KiloPassChurnkeyCancelFlowProvider(props: { children: ReactNode }) {
  const { children } = props;
  const [isOpeningCancelFlow, setIsOpeningCancelFlow] = useState(false);
  const [coordinator] = useState(() => createKiloPassChurnkeyCancelFlow());

  const value = useMemo<KiloPassChurnkeyCancelFlowContextValue>(
    () => ({ coordinator, isOpeningCancelFlow, setIsOpeningCancelFlow }),
    [coordinator, isOpeningCancelFlow]
  );

  return createElement(KiloPassChurnkeyCancelFlowContext.Provider, { value }, children);
}

export function useKiloPassChurnkeyCancelFlow(params: UseKiloPassChurnkeyCancelFlowParams): {
  openCancelFlow: () => Promise<void>;
  isOpeningCancelFlow: boolean;
} {
  const { stripeSubscriptionId, fallbackCancelSubscription, onBeforeOpen } = params;
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const sharedCancelFlow = useContext(KiloPassChurnkeyCancelFlowContext);
  const [localIsOpeningCancelFlow, setLocalIsOpeningCancelFlow] = useState(false);
  const [localCoordinator] = useState(() => createKiloPassChurnkeyCancelFlow());

  const coordinator = sharedCancelFlow?.coordinator ?? localCoordinator;
  const isOpeningCancelFlow = sharedCancelFlow?.isOpeningCancelFlow ?? localIsOpeningCancelFlow;
  const setIsOpeningCancelFlow =
    sharedCancelFlow?.setIsOpeningCancelFlow ?? setLocalIsOpeningCancelFlow;

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
      setIsOpeningCancelFlow,
      stripeSubscriptionId,
      trpc,
      trpcClient,
    ]
  );

  return { openCancelFlow, isOpeningCancelFlow };
}
