'use client';

import { ClawSettingsPage } from '@/app/(app)/claw/components/ClawSettingsPage';

export function OrgClawSettingsClient({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  return <ClawSettingsPage organizationId={organizationId} organizationName={organizationName} />;
}
