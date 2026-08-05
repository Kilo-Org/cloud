'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import { isSeatsTerminal } from './helpers';
import { TerminalToggle } from './TerminalToggle';
import { SeatsGroup } from './seats/SeatsGroup';
import { OrgKiloPassGroup } from './org-kilo-pass/OrgKiloPassGroup';

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
  // Shares the OrgKiloPassGroup summary query cache; used only to surface the
  // "Show ended" toggle when an ended org-pass agreement exists.
  const kiloPassSummaryQuery = useQuery(
    trpc.organizations.kiloPass.summary.queryOptions(
      { organizationId },
      { enabled: !!organizationId }
    )
  );

  const hasTerminalSubscriptions =
    (subscriptionQuery.data?.subscription != null &&
      isSeatsTerminal(subscriptionQuery.data.subscription.status)) ||
    kiloPassSummaryQuery.data?.commercialState === 'ended';

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
        addOn={
          <OrgKiloPassGroup organizationId={organizationId} showTerminal={showTerminal} unframed />
        }
      />
    </PageLayout>
  );
}
