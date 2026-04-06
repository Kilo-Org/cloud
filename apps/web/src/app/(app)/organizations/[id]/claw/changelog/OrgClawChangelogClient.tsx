'use client';

import { ClawChangelogPage } from '@/app/(app)/claw/components/ClawChangelogPage';

export function OrgClawChangelogClient({ organizationId }: { organizationId: string }) {
  return <ClawChangelogPage organizationId={organizationId} />;
}
