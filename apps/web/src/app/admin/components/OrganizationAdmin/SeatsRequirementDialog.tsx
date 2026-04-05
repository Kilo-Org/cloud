'use client';

import { Button } from '@/components/ui/button';
import { BooleanBadge } from '@/components/ui/boolean-badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateOrganizationSeatsRequired } from '@/app/api/organizations/hooks';

type Props = {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingValue: boolean | null;
};

export function SeatsRequirementDialog({
  organizationId,
  open,
  onOpenChange,
  pendingValue,
}: Props) {
  const updateSeatsRequired = useUpdateOrganizationSeatsRequired();

  const handleConfirm = async () => {
    if (pendingValue === null) return;

    try {
      await updateSeatsRequired.mutateAsync({
        organizationId,
        seatsRequired: pendingValue,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update seats requirement:', error);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm Seats Requirement Change</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            Are you sure you want to{' '}
            <BooleanBadge positive={!!pendingValue}>
              {pendingValue ? 'enable' : 'disable'}
            </BooleanBadge>{' '}
            seats for this organization?
          </DialogDescription>
          <DialogDescription>
            {pendingValue
              ? 'This will require the organization to maintain a valid seats subscription to function properly.'
              : 'This will remove the seats subscription requirement.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={updateSeatsRequired.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={updateSeatsRequired.isPending}
            variant={pendingValue ? 'default' : 'destructive'}
          >
            {updateSeatsRequired.isPending ? 'Updating...' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
