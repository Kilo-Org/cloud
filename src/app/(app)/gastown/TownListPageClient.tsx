'use client';

import { GastownOverviewClient } from '@/components/gastown/GastownOverviewClient';

export function TownListPageClient() {
  return (
    <GastownOverviewClient
      mode="personal"
      basePath="/gastown"
      onboardingUrl="/gastown/onboarding"
    />
  );
}
