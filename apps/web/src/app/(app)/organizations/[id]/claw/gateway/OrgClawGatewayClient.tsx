'use client';

import { ClawGatewayPage } from '@/app/(app)/claw/components/ClawGatewayPage';

export function OrgClawGatewayClient({ organizationId }: { organizationId: string }) {
  return <ClawGatewayPage organizationId={organizationId} />;
}
