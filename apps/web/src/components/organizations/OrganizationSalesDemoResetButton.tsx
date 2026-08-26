'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useUserOrganizationRole } from '@/components/organizations/OrganizationContext';

export function OrganizationSalesDemoResetButton({
  organizationId,
  isSalesDemo,
}: {
  organizationId: string;
  isSalesDemo: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const role = useUserOrganizationRole();

  const [isOpen, setIsOpen] = useState(false);

  const resetMutation = useMutation(
    trpc.organizations.salesDemo.reset.mutationOptions({
      onSuccess: () => {
        toast.success('Organization reset');
        setIsOpen(false);
        void queryClient.invalidateQueries({ queryKey: trpc.organizations.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.usageAnalytics.pathKey() });
      },
    })
  );

  if (!isSalesDemo || role !== 'owner') {
    return null;
  }

  const handleReset = async () => {
    try {
      await resetMutation.mutateAsync({ organizationId });
    } catch {
      // Keep the confirm dialog open on failure.
      toast.error('Could not reset the organization. Try again.');
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        // Ignore dismiss requests while a reset is in flight.
        if (resetMutation.isPending) return;
        setIsOpen(open);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Reset organization
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset organization</DialogTitle>
          <DialogDescription>
            This restores the $25.03 balance and 30 days of populated usage.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setIsOpen(false)}
            disabled={resetMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleReset} disabled={resetMutation.isPending}>
            {resetMutation.isPending ? 'Resetting organization...' : 'Reset organization'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
