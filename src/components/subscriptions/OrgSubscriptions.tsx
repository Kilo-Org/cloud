'use client';

import { useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { TerminalToggle } from './TerminalToggle';
import { SeatsGroup } from './seats/SeatsGroup';

export function OrgSubscriptions({ organizationId }: { organizationId: string }) {
  const [showTerminal, setShowTerminal] = useState(false);
  const organizationQuery = useOrganizationWithMembers(organizationId, {
    enabled: !!organizationId,
  });

  return (
    <PageLayout
      title="Subscriptions"
      subtitle={`Manage subscriptions for ${organizationQuery.data?.name ?? 'your organization'}.`}
      headerActions={
        <TerminalToggle
          label="Show ended"
          checked={showTerminal}
          onCheckedChange={setShowTerminal}
        />
      }
    >
      <SeatsGroup organizationId={organizationId} showTerminal={showTerminal} />
    </PageLayout>
  );
}
