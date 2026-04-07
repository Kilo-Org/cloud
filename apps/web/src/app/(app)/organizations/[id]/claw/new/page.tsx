'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { ClawGettingStarted } from '@/app/(app)/claw/components/ClawGettingStarted';

type OrgClawNewPageProps = {
  params: Promise<{ id: string }>;
};

export default function OrgClawNewPage({ params }: OrgClawNewPageProps) {
  const router = useRouter();
  const { id: organizationId } = use(params);
  const { data: status, isLoading } = useOrgKiloClawStatus(organizationId);

  const hasInstance = !!status?.status;

  useEffect(() => {
    if (!isLoading && hasInstance) {
      router.replace(`/organizations/${organizationId}/claw/chat`);
    }
  }, [hasInstance, isLoading, organizationId, router]);

  if (isLoading || hasInstance) {
    return null;
  }

  return (
    <ClawGettingStarted
      status={status}
      isNewSetup={false}
      onNewSetupChange={() => {}}
      organizationId={organizationId}
    />
  );
}
