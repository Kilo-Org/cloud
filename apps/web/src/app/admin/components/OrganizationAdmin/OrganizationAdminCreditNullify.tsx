'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useNullifyOrganizationCredits } from '@/app/admin/api/organizations/hooks';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { toast } from 'sonner';

export function OrganizationAdminCreditNullify({ organizationId }: { organizationId: string }) {
  const { data: session } = useSession();
  const { data: organization } = useOrganizationWithMembers(organizationId);
  const nullifyCreditsMutation = useNullifyOrganizationCredits();

  const [description, setDescription] = useState<string>('');
  const [isOpen, setIsOpen] = useState(false);

  const currentBalance =
    (organization?.total_microdollars_acquired ?? 0) - (organization?.microdollars_used ?? 0);
  const currentBalanceUsd = currentBalance / 1_000_000;
  const hasCredits = currentBalance > 0;

  const handleNullifyCredits = async () => {
    try {
      const finalDescription = description.trim()
        ? `${description.trim()} (${session?.user?.name || session?.user?.email || 'Admin'})`
        : undefined;

      await nullifyCreditsMutation.mutateAsync({
        organizationId,
        description: finalDescription,
      });

      toast.success(`Successfully nullified $${currentBalanceUsd.toFixed(2)} credits`);
      setDescription('');
      setIsOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to nullify credits');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="h-5 w-5" />
          Nullify Credits
        </CardTitle>
        <CardDescription>Remove all credits from this organization</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Current Balance: </span>
            <span className="font-medium">${currentBalanceUsd.toFixed(2)}</span>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button variant="destructive" disabled={!hasCredits} className="w-full sm:w-auto">
                Nullify All Credits
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm Credit Nullification</DialogTitle>
                <DialogDescription>
                  Are you sure you want to nullify all credits for this organization? This will
                  remove <span className="font-medium">${currentBalanceUsd.toFixed(2)}</span> from
                  their balance. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>

              <div className="py-4">
                <Label
                  className="text-muted-foreground text-sm font-medium"
                  htmlFor="nullify-description"
                >
                  Reason (Optional)
                </Label>
                <Input
                  type="text"
                  placeholder="Enter reason for nullification"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  id="nullify-description"
                />
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleNullifyCredits}
                  disabled={nullifyCreditsMutation.isPending}
                >
                  {nullifyCreditsMutation.isPending ? 'Nullifying...' : 'Confirm Nullification'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {!hasCredits && (
            <p className="text-muted-foreground text-sm">
              This organization has no credits to nullify.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
