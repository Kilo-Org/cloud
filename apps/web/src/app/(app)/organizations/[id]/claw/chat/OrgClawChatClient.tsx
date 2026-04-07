'use client';

import { ClawChatPage } from '@/app/(app)/claw/components/ClawChatPage';

export function OrgClawChatClient({ organizationId }: { organizationId: string }) {
  return <ClawChatPage organizationId={organizationId} />;
}
