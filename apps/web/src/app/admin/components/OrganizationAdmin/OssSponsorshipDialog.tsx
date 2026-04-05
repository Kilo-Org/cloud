'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useEnableOssSponsorship } from '@/app/api/organizations/hooks';
import { toast } from 'sonner';

type OssTier = 1 | 2 | 3;

// Tier names: 1 = Premier, 2 = Growth, 3 = Seed
const TIER_NAMES: Record<OssTier, string> = {
  1: 'Premier',
  2: 'Growth',
  3: 'Seed',
};

type Props = {
  organizationId: string;
  organizationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function OssSponsorshipDialog({
  organizationId,
  organizationName,
  open,
  onOpenChange,
}: Props) {
  const [tier, setTier] = useState<OssTier>(1);
  const [monthlyCredits, setMonthlyCredits] = useState<number>(100);
  const [addInitialGrant, setAddInitialGrant] = useState(false);
  const [sendEmail, setSendEmail] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  const enableOssMutation = useEnableOssSponsorship();

  // Seed tier (3) always has 0 credits
  const isSeedTier = tier === 3;
  const effectiveMonthlyCredits = isSeedTier ? 0 : monthlyCredits;

  const handleSubmit = () => {
    // If there are credits to add and addInitialGrant is checked, show confirmation
    if (effectiveMonthlyCredits > 0 && addInitialGrant) {
      setConfirmDialogOpen(true);
    } else {
      // No credits to add or user doesn't want initial grant - proceed directly
      executeEnableOss();
    }
  };

  const executeEnableOss = () => {
    enableOssMutation.mutate(
      {
        organizationId,
        tier,
        monthlyTopUpDollars: effectiveMonthlyCredits,
        addInitialGrant,
        sendEmail,
      },
      {
        onSuccess: () => {
          const tierName = TIER_NAMES[tier];
          const creditsMsg =
            effectiveMonthlyCredits > 0 ? `, $${effectiveMonthlyCredits}/mo top-up` : '';
          const initialMsg =
            addInitialGrant && effectiveMonthlyCredits > 0 ? ` with initial grant` : '';
          const emailMsg = sendEmail ? `, email sent to owners` : '';
          toast.success(
            `Enabled OSS Sponsorship for ${organizationName} (${tierName}${creditsMsg}${initialMsg}${emailMsg})`
          );
          onOpenChange(false);
          resetForm();
        },
        onError: error => {
          toast.error(error.message || 'Failed to enable OSS sponsorship');
        },
      }
    );
    setConfirmDialogOpen(false);
  };

  const resetForm = () => {
    setTier(1);
    setMonthlyCredits(100);
    setAddInitialGrant(false);
    setSendEmail(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable OSS Sponsorship</DialogTitle>
            <DialogDescription>
              Configure OSS sponsorship settings for{' '}
              <span className="font-semibold">{organizationName}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tier">Sponsorship Tier</Label>
              <select
                id="tier"
                value={tier}
                onChange={e => setTier(Number(e.target.value) as OssTier)}
                className="bg-background border-input w-full rounded-md border px-3 py-2"
              >
                <option value={1}>Premier (Tier 1)</option>
                <option value={2}>Growth (Tier 2)</option>
                <option value={3}>Seed (Tier 3 - no credits)</option>
              </select>
            </div>

            {!isSeedTier && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="monthlyCredits">Monthly Credits (USD)</Label>
                  <Input
                    id="monthlyCredits"
                    type="number"
                    min={0}
                    step={1}
                    value={monthlyCredits}
                    onChange={e => setMonthlyCredits(Number(e.target.value))}
                  />
                  <p className="text-muted-foreground text-sm">
                    Amount to top up to each month if balance falls below this amount
                  </p>
                </div>

                {monthlyCredits > 0 && (
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="addInitialGrant"
                      checked={addInitialGrant}
                      onCheckedChange={checked => setAddInitialGrant(checked === true)}
                    />
                    <Label htmlFor="addInitialGrant" className="cursor-pointer">
                      Add ${monthlyCredits} to organization now?
                    </Label>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center space-x-2">
              <Checkbox
                id="sendEmail"
                checked={sendEmail}
                onCheckedChange={checked => setSendEmail(checked === true)}
              />
              <Label htmlFor="sendEmail" className="cursor-pointer">
                Send Email?
              </Label>
            </div>

            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-sm">
              <p className="mb-2 font-medium">This will:</p>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                <li>Set the organization plan to Enterprise</li>
                <li>Disable seat requirements</li>
                <li>Suppress trial messaging</li>
                <li>Extend trial end date by 1 year</li>
                {!isSeedTier && effectiveMonthlyCredits > 0 && (
                  <>
                    <li>Set ${effectiveMonthlyCredits}/month as the credit top-up amount</li>
                    {!addInitialGrant && (
                      <li className="text-yellow-400">
                        Monthly top-up will start on next reset cycle (no immediate credits)
                      </li>
                    )}
                  </>
                )}
                {isSeedTier && (
                  <li className="text-yellow-400">No credits will be granted (Seed tier)</li>
                )}
                {sendEmail ? (
                  <li className="font-medium text-blue-400">
                    Email notification will be sent to owners
                  </li>
                ) : (
                  <li className="font-medium text-green-400">No email will be sent</li>
                )}
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={enableOssMutation.isPending}>
              {enableOssMutation.isPending ? 'Enabling...' : 'Enable OSS Sponsorship'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Initial Credit Grant</DialogTitle>
            <DialogDescription>
              You&apos;re about to add{' '}
              <span className="font-semibold">${effectiveMonthlyCredits}</span> in credits to{' '}
              <span className="font-semibold">{organizationName}</span> immediately.
              <br />
              <br />
              The 30-day credit reset mechanism will also be configured to top up to this amount
              monthly.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={executeEnableOss} disabled={enableOssMutation.isPending}>
              {enableOssMutation.isPending ? 'Adding...' : 'Confirm & Add Credits'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
