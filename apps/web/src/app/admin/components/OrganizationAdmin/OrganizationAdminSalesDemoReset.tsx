'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { RefreshCcw } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useInvalidateAllOrganizationData,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';

export function OrganizationAdminSalesDemoReset({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAllOrganizationData();
  const { data: organization } = useOrganizationWithMembers(organizationId);

  const [isOpen, setIsOpen] = useState(false);

  const resetMutation = useMutation(
    trpc.admin.salesDemo.reset.mutationOptions({
      onSuccess: data => {
        toast.success(`Reset demo organization "${data.organizationName}"`);
        setIsOpen(false);
        void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void queryClient.invalidateQueries({ queryKey: trpc.usageAnalytics.pathKey() });
        void invalidate();
      },
    })
  );

  const isSalesDemo = organization?.settings.is_sales_demo === true;

  if (!isSalesDemo) {
    return null;
  }

  const handleReset = async () => {
    try {
      await resetMutation.mutateAsync({ organizationId });
    } catch (error) {
      // Keep the confirm dialog open on failure.
      toast.error(error instanceof Error ? error.message : 'Failed to reset demo organization');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCcw className="h-5 w-5" />
          Reset demo organization
        </CardTitle>
        <CardDescription>
          Restore the $25.03 populated balance, the owner plus 25 demo members, and the demo
          organization settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog
          open={isOpen}
          onOpenChange={open => {
            // Ignore dismiss requests while a reset is in flight.
            if (resetMutation.isPending) return;
            setIsOpen(open);
          }}
        >
          <DialogTrigger asChild>
            <Button className="w-full sm:w-auto">Reset demo organization</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset demo organization</DialogTitle>
              <DialogDescription>
                This restores the organization to its demo state: a $25.03 populated balance, the
                owner plus 25 demo members, and 30 days of usage.
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
                {resetMutation.isPending ? 'Resetting...' : 'Reset demo organization'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
