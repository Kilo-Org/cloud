'use client';

import { GastownOverviewClient } from '@/components/gastown/GastownOverviewClient';

type OrgTownListPageClientProps = {
  organizationId: string;
  role: string;
};

export function OrgTownListPageClient({ organizationId }: OrgTownListPageClientProps) {
  return (
    <GastownOverviewClient
      mode="org"
      organizationId={organizationId}
      basePath={`/organizations/${organizationId}/gastown`}
      onboardingUrl={`/gastown/onboarding?orgId=${encodeURIComponent(organizationId)}`}
    />
  );
}
