'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateOrganizationFreeTrialEndAt } from '@/app/api/organizations/hooks';
import { useState, useEffect } from 'react';

type Props = {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTrialEndAt: string | null;
};

export function TrialEndDateDialog({
  organizationId,
  open,
  onOpenChange,
  currentTrialEndAt,
}: Props) {
  const [selectedDate, setSelectedDate] = useState<string>('');
  const updateFreeTrialEndAt = useUpdateOrganizationFreeTrialEndAt();

  // Reset to current date when dialog opens
  useEffect(() => {
    if (open) {
      if (currentTrialEndAt) {
        const date = new Date(currentTrialEndAt);
        setSelectedDate(date.toISOString().split('T')[0]);
      } else {
        setSelectedDate('');
      }
    }
  }, [open, currentTrialEndAt]);

  const handleConfirm = async () => {
    try {
      let freeTrialEndAt: string | null = null;
      if (selectedDate) {
        // Set time to end of day (23:59:59) for the selected date
        const dateTime = new Date(`${selectedDate}T23:59:59`);
        freeTrialEndAt = dateTime.toISOString();
      }

      await updateFreeTrialEndAt.mutateAsync({
        organizationId,
        free_trial_end_at: freeTrialEndAt,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update trial end date:', error);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleClear = async () => {
    try {
      await updateFreeTrialEndAt.mutateAsync({
        organizationId,
        free_trial_end_at: null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to clear trial end date:', error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Trial End Date</DialogTitle>
          <DialogDescription>
            Set the date when the free trial ends for this organization. The trial will end at the
            end of the selected day. Leave empty to clear the trial end date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="trial-end-date">Trial End Date</Label>
            <Input
              id="trial-end-date"
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="w-full"
            />
          </div>
        </div>
        <DialogFooter className="flex justify-between">
          <Button
            variant="outline"
            onClick={handleClear}
            disabled={updateFreeTrialEndAt.isPending || !currentTrialEndAt}
          >
            Clear
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={updateFreeTrialEndAt.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={updateFreeTrialEndAt.isPending}>
              {updateFreeTrialEndAt.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
