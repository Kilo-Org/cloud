'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Mail, X, PartyPopperIcon } from 'lucide-react';
import { InviteMemberDialog } from './members/InviteMemberDialog';
import BuyOrganizationCreditsDialog from '@/components/payment/BuyOrganizationCreditsDialog';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import { capitalize } from '@/lib/utils';

type NewOrganizationWelcomeHeaderProps = {
  organizationId: string;
  organizationName: string;
  plan: OrganizationPlan;
  onDismiss: () => void;
};

export function NewOrganizationWelcomeHeader({
  organizationId,
  plan,
  onDismiss,
}: NewOrganizationWelcomeHeaderProps) {
  const [isInviteMemberDialogOpen, setIsInviteMemberDialogOpen] = useState(false);

  return (
    <Card className="border-green-900 bg-green-950/30">
      <CardContent className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-900/50">
              <PartyPopperIcon className="h-6 w-6 text-green-400" />
            </div>
          </div>
          <div className="flex-1">
            <h3 className="mb-2 text-xl font-semibold text-green-100">
              Welcome to Kilo {titleCase(plan)}!
            </h3>
            <div className="mb-4 space-y-2 text-green-200">
              <p>Invite your team members to start coding together today!</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                onClick={() => setIsInviteMemberDialogOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 focus:ring-2 focus:ring-green-400 focus:ring-green-500 focus:outline-none"
              >
                <Users className="h-4 w-4" />
                Invite team members
              </Button>
              <BuyOrganizationCreditsDialog organizationId={organizationId} />
              <a
                href="mailto:teams@kilocode.ai"
                className="bg-background inline-flex items-center justify-center gap-2 rounded-md border border-green-700 px-4 py-2 text-sm font-medium text-green-400 hover:bg-green-950/50 focus:ring-2 focus:ring-green-400 focus:ring-green-500 focus:outline-none"
              >
                <Mail className="h-4 w-4" />
                Contact teams@kilocode.ai
              </a>
            </div>
          </div>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="shrink-0 rounded-full p-1 text-green-400 hover:bg-green-900/50 hover:text-green-300 focus:ring-2 focus:ring-green-500 focus:outline-none"
            aria-label="Dismiss welcome message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardContent>

      <InviteMemberDialog
        open={isInviteMemberDialogOpen}
        onOpenChange={setIsInviteMemberDialogOpen}
        organizationId={organizationId}
        onMemberInvited={() => {
          // Optional: Add any callback logic here
        }}
      />
    </Card>
  );
}
