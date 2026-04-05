'use client';

import { useState } from 'react';
import { Banner } from '@/components/shared/Banner';
import { Users, Mail, PartyPopperIcon } from 'lucide-react';
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
    <>
      <Banner color="green" size="lg">
        <Banner.Icon>
          <PartyPopperIcon className="h-6 w-6" />
        </Banner.Icon>
        <Banner.Content>
          <Banner.Title>Welcome to Kilo {capitalize(plan)}!</Banner.Title>
          <Banner.Description>
            Invite your team members to start coding together today!
          </Banner.Description>
          <Banner.Action>
            <Banner.Button onClick={() => setIsInviteMemberDialogOpen(true)}>
              <Users />
              Invite team members
            </Banner.Button>
            <BuyOrganizationCreditsDialog organizationId={organizationId} />
            <Banner.Button href="mailto:teams@kilocode.ai" variant="outline">
              <Mail />
              Contact teams@kilocode.ai
            </Banner.Button>
          </Banner.Action>
        </Banner.Content>
        <Banner.Dismiss onDismiss={onDismiss} />
      </Banner>

      <InviteMemberDialog
        open={isInviteMemberDialogOpen}
        onOpenChange={setIsInviteMemberDialogOpen}
        organizationId={organizationId}
        onMemberInvited={() => {
          // Optional: Add any callback logic here
        }}
      />
    </>
  );
}
