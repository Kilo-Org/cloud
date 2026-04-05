'use client';

import { use } from 'react';
import { OnboardingTooltips } from '@/components/gastown/OnboardingTooltips';

export function OnboardingTooltipsWrapper({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = use(params);
  return <OnboardingTooltips townId={townId} />;
}
