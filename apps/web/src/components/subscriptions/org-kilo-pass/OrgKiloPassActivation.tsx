'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/lib/trpc/utils';
import { toActivationView } from './mappers';
import { OrgKiloPassActivationView } from './OrgKiloPassActivationView';
import { useOpenBillingPortal } from './useOpenBillingPortal';

const POLL_INTERVAL_MS = 2_500;

export function OrgKiloPassActivation({
  organizationId,
  checkoutSessionId,
}: {
  organizationId: string;
  checkoutSessionId: string;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const { openBillingPortal } = useOpenBillingPortal(organizationId);
  const query = useQuery({
    ...trpc.organizations.kiloPass.activation.queryOptions({ organizationId, checkoutSessionId }),
    enabled: Boolean(checkoutSessionId),
    refetchInterval: current => {
      if (!current.state.data) return POLL_INTERVAL_MS;
      return toActivationView(current.state.data).shouldPoll ? POLL_INTERVAL_MS : false;
    },
  });

  if (!checkoutSessionId) {
    return (
      <OrgKiloPassActivationView
        state="blocked"
        title="Checkout could not be confirmed"
        description="Return to subscriptions to check your Kilo Pass status."
        actionLabel="View subscriptions"
        onAction={() => router.replace(`/organizations/${organizationId}/subscriptions`)}
      />
    );
  }

  if (query.isError) {
    return (
      <OrgKiloPassActivationView
        state="blocked"
        title="Activation status could not be loaded"
        description="Something went wrong while checking your Kilo Pass activation."
        actionLabel="Try again"
        onAction={() => void query.refetch()}
      />
    );
  }

  const view = toActivationView(query.data ?? null);
  const onAction = () => {
    if (view.actionTarget === 'billing_portal') openBillingPortal();
    else if (view.actionTarget === 'kilo_pass_detail')
      router.replace(`/organizations/${organizationId}/subscriptions/kilo-pass`);
    else router.replace(`/organizations/${organizationId}/subscriptions`);
  };

  return (
    <OrgKiloPassActivationView
      state={view.state}
      title={view.title}
      description={view.description}
      actionLabel={view.actionLabel}
      onAction={view.actionLabel ? onAction : undefined}
    />
  );
}
