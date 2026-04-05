'use client';

import { ClawSettingsPage } from '@/app/(app)/claw/components/ClawSettingsPage';

export function OrgClawSettingsClient({ organizationId }: { organizationId: string }) {
  return <ClawSettingsPage organizationId={organizationId} />;
}
