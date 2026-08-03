'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useRawTRPCClient } from '@/lib/trpc/utils';

/**
 * Opens the organization's Stripe customer portal, returning to the current
 * page. Guards against duplicate opens while the portal URL is being created.
 */
export function useOpenBillingPortal(organizationId: string) {
  const trpcClient = useRawTRPCClient();
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);

  const openBillingPortal = () => {
    if (isOpeningPortal) return;
    setIsOpeningPortal(true);
    void (async () => {
      try {
        const result = await trpcClient.organizations.subscription.getCustomerPortalUrl.mutate({
          organizationId,
          returnUrl: window.location.href,
        });
        window.location.href = result.url;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to open billing');
        setIsOpeningPortal(false);
      }
    })();
  };

  return { openBillingPortal, isOpeningPortal };
}
