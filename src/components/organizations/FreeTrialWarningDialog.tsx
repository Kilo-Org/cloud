'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/Button';
import { Lock } from 'lucide-react';
import type {
  OrgTrialStatus,
  OrganizationWithMembers,
} from '@/lib/organizations/organization-types';

type FreeTrialWarningDialogProps = {
  trialStatus: OrgTrialStatus;
  daysExpired: number;
  organization: OrganizationWithMembers;
  onClose?: () => void;
  onUpgradeClick: () => void;
  container?: HTMLElement | null;
  modal?: boolean;
};

export function FreeTrialWarningDialog({
  trialStatus,
  daysExpired,
  organization,
  onClose,
  onUpgradeClick,
  container,
  modal = true,
}: FreeTrialWarningDialogProps) {
  const isHardLock = trialStatus === 'trial_expired_hard';

  return (
    <Dialog open={true} onOpenChange={open => !open && onClose?.()} modal={modal}>
      <DialogContent
        container={container}
        showCloseButton={!isHardLock}
        className="sm:max-w-md"
        onEscapeKeyDown={e => e.preventDefault()}
        onPointerDownOutside={e => e.preventDefault()}
        onInteractOutside={e => e.preventDefault()}
      >
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-red-900/30">
            <div className="relative">
              <Lock className="h-8 w-8 text-red-500" />
              <div className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-red-900 bg-red-600" />
            </div>
          </div>
          <DialogTitle className="text-center text-2xl font-bold text-red-500">
            Access Blocked
          </DialogTitle>
          <DialogDescription className="text-center text-base">
            Your trial expired {daysExpired === 1 ? 'yesterday' : `${daysExpired} days ago`}
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 rounded-lg border border-red-900 bg-red-950/50 p-4">
          <p className="text-center text-sm text-gray-300">
            <strong>{organization.name}</strong> has been locked due to an expired trial. Editing
            and new actions are disabled. Upgrade now to restore full access to all features and
            data.
          </p>
        </div>

        <DialogFooter className="flex-col gap-3 sm:flex-col">
          <Button
            onClick={onUpgradeClick}
            className="w-full bg-red-600 py-3 font-semibold text-white hover:bg-red-700"
          >
            Upgrade to Restore Access
          </Button>
          <p className="text-center text-xs text-gray-400">
            All your data is safe and will be restored immediately after upgrading
          </p>

          {trialStatus === 'trial_expired_soft' ? (
            <Button
              onClick={onClose}
              variant="link"
              className="w-full text-gray-400 hover:text-gray-300"
            >
              Browse Read-Only
            </Button>
          ) : (
            <Button
              onClick={() => (window.location.href = '/profile')}
              variant="link"
              className="w-full text-gray-400 hover:text-gray-300"
            >
              Switch to Personal Profile
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
