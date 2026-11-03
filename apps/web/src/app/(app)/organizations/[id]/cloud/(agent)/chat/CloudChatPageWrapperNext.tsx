'use client';

import { Suspense } from 'react';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';
import type { KnownModel } from '@/components/cloud-agent-next/known-models';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';

type CloudChatPageWrapperNextProps = {
  organizationId: string;
  organizationName?: string;
  organizationRole: OrganizationRole;
  currentUserId: string;
  knownModels: KnownModel[];
};

export function CloudChatPageWrapperNext({
  organizationId,
  organizationName,
  organizationRole,
  currentUserId,
  knownModels,
}: CloudChatPageWrapperNextProps) {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <CloudChatPage
        organizationId={organizationId}
        organizationName={organizationName}
        organizationRole={organizationRole}
        currentUserId={currentUserId}
        knownModels={knownModels}
      />
    </Suspense>
  );
}
