'use client';

import { useEffect, useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { InviteMemberDialog } from '@/components/organizations/members/InviteMemberDialog';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { OrganizationWelcomeCards } from '@/components/organizations/welcome/OrganizationWelcomeCards';

type OrganizationWelcomePageClientProps = {
  organizationId: string;
};

export function OrganizationWelcomePageClient({
  organizationId,
}: OrganizationWelcomePageClientProps) {
  const [blockClose, setBlockClose] = useState(false);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [isCreditDialogOpen, setIsCreditDialogOpen] = useState(false);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('firstTime') !== '1') return;

    setBlockClose(true);
    setIsInviteDialogOpen(true);

    const url = new URL(window.location.href);
    url.searchParams.delete('firstTime');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  return (
    <OrganizationAdminContextProvider organizationId={organizationId}>
      <PageLayout title="Welcome">
        <OrganizationWelcomeCards
          onInviteMemberClick={() => setIsInviteDialogOpen(true)}
          onBuyCreditsClick={() => setIsCreditDialogOpen(true)}
        />

        <InviteMemberDialog
          open={isInviteDialogOpen}
          onOpenChange={setIsInviteDialogOpen}
          organizationId={organizationId}
          onMemberInvited={() => {
            setBlockClose(false);
          }}
          blockClose={blockClose}
        />

        <Dialog open={isCreditDialogOpen} onOpenChange={setIsCreditDialogOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Purchase Credits</DialogTitle>
            </DialogHeader>
            <CreditPurchaseOptions organizationId={organizationId} isFirstPurchase={false} />
          </DialogContent>
        </Dialog>
      </PageLayout>
    </OrganizationAdminContextProvider>
  );
}
