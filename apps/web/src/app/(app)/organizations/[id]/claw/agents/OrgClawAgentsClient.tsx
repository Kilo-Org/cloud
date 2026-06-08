'use client';

import { ClawAgentsPage } from '@/app/(app)/claw/components/ClawAgentsPage';

export function OrgClawAgentsClient({ organizationId }: { organizationId: string }) {
  return <ClawAgentsPage organizationId={organizationId} />;
}
