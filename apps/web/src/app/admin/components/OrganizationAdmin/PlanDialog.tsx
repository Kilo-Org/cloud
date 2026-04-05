'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateOrganizationPlan } from '@/app/api/organizations/hooks';
import { useState, useEffect } from 'react';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';

type Props = {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPlan: OrganizationPlan;
};

export function PlanDialog({ organizationId, open, onOpenChange, currentPlan }: Props) {
  const [selectedPlan, setSelectedPlan] = useState<OrganizationPlan>(currentPlan || 'enterprise');
  const updatePlan = useUpdateOrganizationPlan();

  // Reset to current plan when dialog opens
  useEffect(() => {
    if (open && currentPlan) {
      setSelectedPlan(currentPlan);
    }
  }, [open, currentPlan]);

  const handleConfirm = async () => {
    try {
      await updatePlan.mutateAsync({
        organizationId,
        plan: selectedPlan,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update plan:', error);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Organization Plan</DialogTitle>
          <DialogDescription>
            Select the plan for this organization. This will affect billing and feature access.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="plan-select">Organization Plan</Label>
            <Select
              value={selectedPlan}
              onValueChange={(value: string) => setSelectedPlan(value as 'enterprise' | 'teams')}
            >
              <SelectTrigger id="plan-select">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enterprise">
                  <div className="flex flex-col">
                    <span className="font-medium">Enterprise</span>
                  </div>
                </SelectItem>
                <SelectItem value="teams">
                  <div className="flex flex-col">
                    <span className="font-medium">Teams</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={updatePlan.isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={updatePlan.isPending}>
            {updatePlan.isPending ? 'Updating...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
