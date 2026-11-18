'use client';

import { useState, useMemo } from 'react';
import {
  useOrganizationWithMembers,
  useOrganizationTrialStatus,
} from '@/app/api/organizations/hooks';
import { FreeTrialWarningDialog } from './FreeTrialWarningDialog';
import { FreeTrialWarningBanner } from './FreeTrialWarningBanner';
import { UpgradeTrialDialog } from './UpgradeTrialDialog';
import {
  getDaysRemainingInTrial,
  isStatusReadOnly,
} from '@kilocode/web-shared/lib/organizations/trial-utils';
import { OrganizationUpgradeProvider } from '@/contexts/OrganizationUpgradeContext';
import { LockableContainerProvider } from '@/contexts/LockableContainerContext';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { PageContainer } from '@/components/layouts/PageContainer';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';

type OrganizationTrialWrapperProps = {
  organizationId: string;
  role: OrganizationRole;
  children: React.ReactNode;
  /** When true, render children directly without the PageContainer max-width wrapper. */
  fullBleed?: boolean;
};

export function OrganizationTrialWrapper({
  organizationId,
  role,
  children,
  fullBleed = false,
}: OrganizationTrialWrapperProps) {
  const [softLockDismissed, setSoftLockDismissed] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);

  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const trialStatus = useOrganizationTrialStatus(organizationId);
  const { assumedRole } = useRoleTesting();

  const isTrialLoading = trialStatus === 'loading' || trialStatus === 'error';
  const isLocked = !isTrialLoading && isStatusReadOnly(trialStatus);
  const daysRemaining = organizationData
    ? getDaysRemainingInTrial(
        organizationData.free_trial_end_at ?? null,
        organizationData.created_at
      )
    : 0;

  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role;

  // Provide upgrade dialog trigger to all child components via context
  const contextValue = useMemo(
    () => ({
      openUpgradeDialog: () => setShowUpgradeDialog(true),
    }),
    []
  );

  return (
    <OrganizationUpgradeProvider value={contextValue}>
      <LockableContainerProvider
        value={{
          isLocked,
          tooltipWhenLocked: 'Upgrade to Use',
        }}
      >
        {/* Trial Lock Dialog - shows on top of everything when in lock state */}
        {isLocked && organizationData && !isTrialLoading && !softLockDismissed && (
          <FreeTrialWarningDialog
            trialStatus={trialStatus}
            daysExpired={Math.abs(daysRemaining)}
            organization={organizationData}
            onClose={
              trialStatus === 'trial_expired_soft' ? () => setSoftLockDismissed(true) : undefined
            }
            onUpgradeClick={() => setShowUpgradeDialog(true)}
          />
        )}

        {/* Upgrade Dialog - separate from lock dialog */}
        {showUpgradeDialog && organizationData && (
          <UpgradeTrialDialog
            open={showUpgradeDialog}
            onOpenChange={setShowUpgradeDialog}
            organizationId={organizationId}
            organizationName={organizationData.name}
            currentPlan={organizationData.plan}
          />
        )}

        <div className="w-full">
          {trialStatus !== 'subscribed' && !isTrialLoading && organizationData && (
            <FreeTrialWarningBanner
              organization={organizationData}
              daysRemaining={daysRemaining}
              userRole={currentRole}
              onUpgradeClick={() => setShowUpgradeDialog(true)}
            />
          )}

          {fullBleed ? children : <PageContainer>{children}</PageContainer>}
        </div>
      </LockableContainerProvider>
    </OrganizationUpgradeProvider>
  );
}
