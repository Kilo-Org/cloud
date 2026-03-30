'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar, Repeat } from 'lucide-react';
import type { BillingCycle, OrganizationPlan } from '@/lib/organizations/organization-types';
import { seatPrice } from '@/lib/organizations/constants';

type BillingCycleChangeDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  targetCycle: BillingCycle;
  currentCycle: BillingCycle;
  seatCount: number;
  plan: OrganizationPlan;
  effectiveDate: string | null;
};

function getPricing(plan: OrganizationPlan, cycle: BillingCycle) {
  const monthlyRate = seatPrice(plan, cycle);
  return {
    monthlyRate,
    billingAmount: cycle === 'annual' ? monthlyRate * 12 : monthlyRate,
    billingLabel: cycle === 'annual' ? '/seat/year' : '/seat/month',
  };
}

export function BillingCycleChangeDialog({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  targetCycle,
  currentCycle,
  seatCount,
  plan,
  effectiveDate,
}: BillingCycleChangeDialogProps) {
  const currentPricing = getPricing(plan, currentCycle);
  const newPricing = getPricing(plan, targetCycle);

  const currentMonthlyTotal = currentPricing.monthlyRate * seatCount;
  const newMonthlyTotal = newPricing.monthlyRate * seatCount;
  const newAnnualTotal = targetCycle === 'annual' ? newPricing.billingAmount * seatCount : null;

  const switchingToMonthly = targetCycle === 'monthly';
  const targetLabel = targetCycle === 'annual' ? 'Annual' : 'Monthly';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            Switch to {targetLabel} Billing
          </DialogTitle>
          <DialogDescription>Review the billing changes below before confirming.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Cycle comparison */}
          <div className="rounded-lg border p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Now</p>
                  <p className="text-sm font-medium">
                    {currentCycle === 'annual' ? 'Annual' : 'Monthly'} billing
                  </p>
                </div>
                <p className="text-sm font-semibold">${currentPricing.monthlyRate}/seat/month</p>
              </div>

              <div className="border-t" />

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">New</p>
                  <p className="text-sm font-medium">{targetLabel} billing</p>
                </div>
                <p className="text-sm font-semibold">${newPricing.monthlyRate}/seat/month</p>
              </div>
            </div>
          </div>

          {/* Total cost comparison */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm">
                {seatCount} seat{seatCount !== 1 ? 's' : ''}
              </p>
              <div className="text-right">
                <p className="text-muted-foreground text-xs line-through">
                  ${currentMonthlyTotal.toLocaleString()}/mo
                </p>
                <p className="text-sm font-semibold">${newMonthlyTotal.toLocaleString()}/mo</p>
                {newAnnualTotal != null && (
                  <p className="text-muted-foreground text-xs">
                    Billed as ${newAnnualTotal.toLocaleString()}/yr
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Takes effect annotation */}
          <div className="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/[0.08] p-3">
            <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
            <p className="text-sm text-blue-300">
              {effectiveDate ? (
                <>
                  Takes effect on <span className="font-semibold">{effectiveDate}</span>.
                </>
              ) : (
                <>
                  Takes effect at the{' '}
                  <span className="font-semibold">end of the current billing period</span>.
                </>
              )}
            </p>
          </div>

          {/* Cost warning for switching to monthly (losing annual discount) */}
          {switchingToMonthly && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.08] p-3">
              <p className="text-sm text-amber-300">
                Switching to monthly billing will increase your per-seat cost from $
                {currentPricing.monthlyRate} to ${newPricing.monthlyRate} per month. The annual plan
                offers 12 months for the price of 10.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isLoading}>
            {isLoading ? 'Switching...' : `Switch to ${targetLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
