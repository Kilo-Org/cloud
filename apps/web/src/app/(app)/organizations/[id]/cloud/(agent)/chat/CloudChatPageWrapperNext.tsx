'use client';

import { Suspense } from 'react';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

type CloudChatPageWrapperNextProps = {
  organizationId: string;
  organizationName?: string;
  organizationRole: OrganizationRole;
  currentUserId: string;
};

export function CloudChatPageWrapperNext({
  organizationId,
  organizationName,
  organizationRole,
  currentUserId,
}: CloudChatPageWrapperNextProps) {
  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <CloudChatPage
        organizationId={organizationId}
        organizationName={organizationName}
        organizationRole={organizationRole}
        currentUserId={currentUserId}
      />
    </Suspense>
  );
}
