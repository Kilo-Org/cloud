'use client';

import { useState, useEffect } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { InviteMemberDialog } from '@/components/organizations/members/InviteMemberDialog';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { useParams } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { OrganizationWelcomeCards } from '@/components/organizations/welcome/OrganizationWelcomeCards';

export default function OrganizationStartPage() {
  const params = useParams();
  const orgId = params.id as string;
  const [blockClose, setBlockClose] = useState(false);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [isCreditDialogOpen, setIsCreditDialogOpen] = useState(false);

  // Check for firstTime query param on mount and remove from URL
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('firstTime') === '1') {
        setBlockClose(true);
        setIsInviteDialogOpen(true);

        // Remove query param from URL without adding to history
        const url = new URL(window.location.href);
        url.searchParams.delete('firstTime');
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    }
  }, []);

  return (
    <OrganizationAdminContextProvider organizationId={orgId}>
      <PageLayout title="Welcome">
        <OrganizationWelcomeCards
          onInviteMemberClick={() => setIsInviteDialogOpen(true)}
          onBuyCreditsClick={() => setIsCreditDialogOpen(true)}
        />

        <InviteMemberDialog
          open={isInviteDialogOpen}
          onOpenChange={setIsInviteDialogOpen}
          organizationId={orgId}
          onMemberInvited={() => {
            setBlockClose(false);
          }}
          blockClose={blockClose}
        />

        {/* Credit Purchase Dialog */}
        <Dialog open={isCreditDialogOpen} onOpenChange={setIsCreditDialogOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Purchase Credits</DialogTitle>
            </DialogHeader>
            <CreditPurchaseOptions organizationId={orgId} isFirstPurchase={false} />
          </DialogContent>
        </Dialog>
      </PageLayout>
    </OrganizationAdminContextProvider>
  );
}
