'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { SupportAccessRequestDialog } from '@/components/organizations/SupportAccessRequestDialog';
import { useAdminOrganizationDetails } from '@/app/admin/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';

export function OrganizationAdminSupportAccessPrompt({
  organizationId,
}: {
  organizationId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const viewAccess = useQuery(trpc.admin.supportAccess.viewAccess.queryOptions({ organizationId }));
  const details = useAdminOrganizationDetails(organizationId);

  if (!viewAccess.data?.grantRequired) return null;

  const organizationName = details.data?.name ?? organizationId;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <div>
        <p className="font-medium">Support access needed</p>
        <p>
          You are not a member of {organizationName}. Customer data on this page (organization
          details, usage, members, credits) needs a support grant. Admin-only controls still work.
        </p>
      </div>
      <Button onClick={() => setOpen(true)}>Request access</Button>
      <SupportAccessRequestDialog
        open={open}
        onOpenChange={setOpen}
        organizationId={organizationId}
        organizationName={organizationName}
        onGranted={grant => {
          if (grant.status === 'active') void queryClient.invalidateQueries();
        }}
      />
    </div>
  );
}
