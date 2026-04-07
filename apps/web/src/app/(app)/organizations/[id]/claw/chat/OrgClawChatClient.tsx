'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ClawChatPage } from '@/app/(app)/claw/components/ClawChatPage';

export function OrgClawChatClient({ organizationId }: { organizationId: string }) {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash === 'changelog') {
      router.replace(`/organizations/${organizationId}/claw/changelog`);
    }
  }, [organizationId, router]);

  return <ClawChatPage organizationId={organizationId} />;
}
