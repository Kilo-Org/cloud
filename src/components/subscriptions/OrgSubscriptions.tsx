'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import { isSeatsTerminal } from './helpers';
import { TerminalToggle } from './TerminalToggle';
import { SeatsGroup } from './seats/SeatsGroup';

export function OrgSubscriptions({ organizationId }: { organizationId: string }) {
  const [showTerminal, setShowTerminal] = useState(false);
  const trpc = useTRPC();
  const organizationQuery = useOrganizationWithMembers(organizationId, {
    enabled: !!organizationId,
  });
  const subscriptionQuery = useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId },
      { enabled: !!organizationId }
    )
  );

  const hasTerminalSubscriptions =
    subscriptionQuery.data?.subscription != null &&
    isSeatsTerminal(subscriptionQuery.data.subscription.status);

  return (
    <PageLayout
      title="Subscriptions"
      subtitle={`Manage subscriptions for ${organizationQuery.data?.name ?? 'your organization'}.`}
      headerActions={
        hasTerminalSubscriptions ? (
          <TerminalToggle
            label="Show ended"
            checked={showTerminal}
            onCheckedChange={setShowTerminal}
          />
        ) : null
      }
    >
      <SeatsGroup
        organizationId={organizationId}
        organizationPlan={organizationQuery.data?.plan ?? 'teams'}
        showTerminal={showTerminal}
      />
    </PageLayout>
  );
}
