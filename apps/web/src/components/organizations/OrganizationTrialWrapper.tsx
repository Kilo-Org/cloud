'use client';

import { useState, useMemo } from 'react';
import {
  useOrganizationWithMembers,
  useOrganizationTrialClassification,
} from '@/app/api/organizations/hooks';
import { FreeTrialWarningDialog } from './FreeTrialWarningDialog';
import { FreeTrialWarningBanner } from './FreeTrialWarningBanner';
import { UpgradeTrialDialog } from './UpgradeTrialDialog';
import {
  isStatusReadOnly,
  type OrganizationTrialDisplayStatus,
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
  const classification = useOrganizationTrialClassification(organizationId);
  const { assumedRole } = useRoleTesting();

  const trialStatus: OrganizationTrialDisplayStatus | 'loading' | 'error' =
    classification === 'loading' || classification === 'error'
      ? classification
      : classification.displayStatus;
  const isTrialLoading = trialStatus === 'loading' || trialStatus === 'error';
  const isLocked = !isTrialLoading && isStatusReadOnly(trialStatus);
  const daysRemaining =
    classification === 'loading' || classification === 'error' ? 0 : classification.daysRemaining;
  // An organization created without a trial has no window to report on, so the
  // banner and the lock dialog describe the missing plan rather than elapsed days.
  const hasTrialWindow =
    organizationData != null &&
    !(organizationData.trial_granted === false && organizationData.free_trial_end_at == null);

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
            hasTrialWindow={hasTrialWindow}
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
              hasTrialWindow={hasTrialWindow}
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
