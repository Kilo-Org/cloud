'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

import { deriveKiloPassSubscriptionInfoView } from './kiloPassSubscriptionInfoView';
import type { KiloPassSubscriptionInfoView } from './kiloPassSubscriptionInfoView';
import type { KiloPassSubscription } from './kiloPassSubscription';

export type { KiloPassSubscriptionInfoView } from './kiloPassSubscriptionInfoView';
export type { KiloPassSubscription } from './kiloPassSubscription';

export type KiloPassSubscriptionInfo = {
  subscription: KiloPassSubscription;
  view: KiloPassSubscriptionInfoView;
  actions: {
    openCustomerPortal: () => void;
    isOpeningCustomerPortal: boolean;
    cancelSubscription: (params?: { onSuccess?: () => void }) => void;
    isCancelingSubscription: boolean;
    resumeSubscription: () => void;
    isResumingSubscription: boolean;
  };
};

const KiloPassSubscriptionInfoContext = createContext<KiloPassSubscriptionInfo | null>(null);

export function KiloPassSubscriptionInfoProvider(props: {
  subscription: KiloPassSubscription;
  children: ReactNode;
}) {
  const { subscription, children } = props;

  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  const [isOpeningCustomerPortal, setIsOpeningCustomerPortal] = useState(false);
  const [isCancelingSubscription, setIsCancelingSubscription] = useState(false);
  const [isResumingSubscription, setIsResumingSubscription] = useState(false);

  const openCustomerPortal = useCallback(() => {
    if (isOpeningCustomerPortal) return;
    setIsOpeningCustomerPortal(true);

    void (async () => {
      try {
        const result = await trpcClient.kiloPass.getCustomerPortalUrl.mutate({
          returnUrl: window.location.href,
        });
        window.location.href = result.url;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to open Stripe customer portal';
        toast.error(message);
      } finally {
        setIsOpeningCustomerPortal(false);
      }
    })();
  }, [isOpeningCustomerPortal, trpcClient]);

  const cancelSubscription = useCallback(
    (params?: { onSuccess?: () => void }) => {
      if (isCancelingSubscription) return;
      setIsCancelingSubscription(true);

      void (async () => {
        try {
          await trpcClient.kiloPass.cancelSubscription.mutate();
          toast('Cancellation scheduled');
          void queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
          });
          params?.onSuccess?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to cancel subscription';
          toast.error(message);
        } finally {
          setIsCancelingSubscription(false);
        }
      })();
    },
    [isCancelingSubscription, queryClient, trpc, trpcClient]
  );

  const resumeSubscription = useCallback(() => {
    if (isResumingSubscription) return;
    setIsResumingSubscription(true);

    void (async () => {
      try {
        await trpcClient.kiloPass.resumeSubscription.mutate();
        toast('Subscription resumed');
        void queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to resume subscription';
        toast.error(message);
      } finally {
        setIsResumingSubscription(false);
      }
    })();
  }, [isResumingSubscription, queryClient, trpc, trpcClient]);

  const view = useMemo(() => deriveKiloPassSubscriptionInfoView(subscription), [subscription]);

  const value: KiloPassSubscriptionInfo = useMemo(
    () => ({
      subscription,
      view,
      actions: {
        openCustomerPortal,
        isOpeningCustomerPortal,
        cancelSubscription,
        isCancelingSubscription,
        resumeSubscription,
        isResumingSubscription,
      },
    }),
    [
      subscription,
      view,
      openCustomerPortal,
      isOpeningCustomerPortal,
      cancelSubscription,
      isCancelingSubscription,
      resumeSubscription,
      isResumingSubscription,
    ]
  );

  return (
    <KiloPassSubscriptionInfoContext.Provider value={value}>
      {children}
    </KiloPassSubscriptionInfoContext.Provider>
  );
}

export function useKiloPassSubscriptionInfo(): KiloPassSubscriptionInfo {
  const value = useContext(KiloPassSubscriptionInfoContext);
  if (!value) {
    throw new Error(
      'useKiloPassSubscriptionInfo must be used within KiloPassSubscriptionInfoProvider'
    );
  }
  return value;
}
