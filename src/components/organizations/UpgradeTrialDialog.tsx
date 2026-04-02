'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PlanCard } from './subscription/PlanCard';
import { Button } from '@/components/Button';
import type { BillingCycle, OrganizationPlan } from '@/lib/organizations/organization-types';
import { seatPrice } from '@/lib/organizations/constants';
import { ENTERPRISE_FEATURES, TEAMS_FEATURES } from './subscription/plan-features';
import {
  useOrganizationSubscriptionLink,
  useOrganizationSeatUsage,
  useResubscribeDefaults,
} from '@/app/api/organizations/hooks';
import { usePostHog } from 'posthog-js/react';

type UpgradeTrialDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationName: string;
  currentPlan: OrganizationPlan;
  container?: HTMLElement | null;
};

export function UpgradeTrialDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  currentPlan,
  container,
}: UpgradeTrialDialogProps) {
  const [selectedPlan, setSelectedPlan] = useState<OrganizationPlan>(currentPlan);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('annual');
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [seatCount, setSeatCount] = useState<number | null>(null);
  const seededFromDefaults = useRef(false);

  // Mark the form as touched when the user manually changes controls so the
  // seeding effect doesn't overwrite their choices if queries resolve late.
  const userSetBillingCycle = (cycle: BillingCycle) => {
    seededFromDefaults.current = true;
    setBillingCycle(cycle);
  };
  const userSetSeatCount = (count: number) => {
    seededFromDefaults.current = true;
    setSeatCount(count);
  };

  const teamPrice = seatPrice('teams', billingCycle);
  const enterprisePrice = seatPrice('enterprise', billingCycle);

  const { data: seatUsage } = useOrganizationSeatUsage(organizationId);
  const { data: resubscribeDefaults } = useResubscribeDefaults(organizationId);

  // Seed billing cycle and seat count once from the last ended subscription.
  // Runs only once (guarded by ref) so later seatUsage refetches don't reset
  // the user's billing-cycle choice.
  useEffect(() => {
    if (seededFromDefaults.current) return;
    if (resubscribeDefaults && seatUsage) {
      seededFromDefaults.current = true;
      setBillingCycle(resubscribeDefaults.billingCycle);
      setSeatCount(Math.max(resubscribeDefaults.defaultSeatCount, seatUsage.usedSeats));
    }
  }, [resubscribeDefaults, seatUsage]);
  // Default to current seat usage (excludes billing managers) clamped to 1-100
  const defaultSeatCount = Math.max(1, Math.min(100, seatUsage?.usedSeats ?? 1));
  const effectiveSeatCount = seatCount ?? defaultSeatCount;
  const subscriptionLink = useOrganizationSubscriptionLink();
  const hog = usePostHog();

  const handleSelectPlan = (plan: OrganizationPlan) => {
    setSelectedPlan(plan);
  };

  const handlePurchase = async () => {
    if (!seatUsage) return;

    setIsPurchasing(true);
    hog?.capture('trial_upgrade_purchase_clicked', {
      organizationId,
      selectedPlan,
      billingCycle,
      seatCount: effectiveSeatCount,
    });

    try {
      const result = await subscriptionLink.mutateAsync({
        organizationId,
        seats: effectiveSeatCount,
        cancelUrl: window.location.href,
        plan: selectedPlan,
        billingCycle,
      });

      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error) {
      console.error('Failed to create subscription link:', error);
      setIsPurchasing(false);
    }
  };

  const planName = selectedPlan === 'teams' ? 'Teams' : 'Enterprise';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container} showCloseButton={true} className="sm:max-w-3xl">
        <div className="space-y-6">
          {/* Header */}
          <div className="text-center">
            <DialogTitle className="text-2xl font-bold text-white">
              Upgrade {organizationName}
            </DialogTitle>
            <p className="text-muted-foreground mt-2">
              Subscribe to continue using {planName} features
            </p>
          </div>

          {/* Billing Cycle Toggle */}
          <div className="flex items-center justify-center gap-3">
            <div className="inline-flex rounded-lg bg-muted p-1">
              <button
                type="button"
                onClick={() => userSetBillingCycle('monthly')}
                className={`rounded-md px-5 py-1.5 text-sm font-medium transition-all ${
                  billingCycle === 'monthly'
                    ? 'bg-blue-600 text-white'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => userSetBillingCycle('annual')}
                className={`rounded-md px-5 py-1.5 text-sm font-medium transition-all ${
                  billingCycle === 'annual'
                    ? 'bg-blue-600 text-white'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Annual
              </button>
            </div>
            <span
              className={`rounded-full border border-green-400/30 bg-green-400/10 px-2.5 py-0.5 text-xs font-semibold text-green-400 transition-[opacity,text-decoration-color] ${
                billingCycle === 'annual'
                  ? 'opacity-100'
                  : 'opacity-30 line-through decoration-current'
              }`}
            >
              Save 17%
            </span>
          </div>

          {/* Plan Cards */}
          <div className="grid gap-4 md:grid-cols-2">
            <PlanCard
              plan="teams"
              pricePerMonth={teamPrice}
              billingCycle={billingCycle}
              features={TEAMS_FEATURES}
              isSelected={selectedPlan === 'teams'}
              currentPlan={currentPlan}
              onSelect={() => handleSelectPlan('teams')}
            />

            <PlanCard
              plan="enterprise"
              pricePerMonth={enterprisePrice}
              billingCycle={billingCycle}
              features={ENTERPRISE_FEATURES}
              isSelected={selectedPlan === 'enterprise'}
              currentPlan={currentPlan}
              onSelect={() => handleSelectPlan('enterprise')}
            />
          </div>

          {/* Seat Count */}
          <div className="flex items-center justify-center gap-4">
            <label htmlFor="seat-count" className="text-sm font-medium text-gray-300">
              Number of seats
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => userSetSeatCount(Math.max(1, effectiveSeatCount - 1))}
                disabled={effectiveSeatCount <= 1}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
              >
                −
              </button>
              <input
                id="seat-count"
                type="number"
                min={1}
                max={100}
                value={effectiveSeatCount}
                onChange={e => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) userSetSeatCount(Math.max(1, Math.min(100, val)));
                }}
                className="h-8 w-16 rounded-md border border-gray-600 bg-gray-800 text-center text-sm text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => userSetSeatCount(Math.min(100, effectiveSeatCount + 1))}
                disabled={effectiveSeatCount >= 100}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
              >
                +
              </button>
            </div>
            {seatUsage && (
              <span className="text-xs text-gray-500">
                ({seatUsage.usedSeats} currently in use)
              </span>
            )}
          </div>

          {/* Purchase Button */}
          <div className="flex flex-col items-center gap-3">
            <Button
              onClick={handlePurchase}
              disabled={isPurchasing || !seatUsage}
              className="w-full max-w-md bg-blue-600 py-4 text-lg font-semibold text-white hover:bg-blue-700"
            >
              {isPurchasing ? 'Processing...' : `Purchase ${planName} Plan`}
            </Button>
            <p className="text-center text-xs text-gray-400">
              You'll be redirected to Stripe to complete your purchase
            </p>
          </div>

          {/* Credit Options */}
          <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
            <h3 className="mb-3 text-center text-sm font-semibold text-white">
              Credits are not included with your subscription. Use what works best for your team no
              matter what plan you choose.
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {/* Kilo Pass */}
              <div className="rounded-md border border-gray-600 bg-gray-900/50 p-3">
                <h4 className="text-sm font-medium text-white">Kilo Pass</h4>
                <p className="mt-1 text-xs text-gray-400">
                  Credit subscription with bonus credits.{' '}
                  <a
                    href="https://kilo.ai/features/kilo-pass"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    Learn more
                  </a>
                </p>
              </div>

              {/* Pay-as-you-go */}
              <div className="rounded-md border border-gray-600 bg-gray-900/50 p-3">
                <h4 className="text-sm font-medium text-white">Pay-as-you-go</h4>
                <p className="mt-1 text-xs text-gray-400">
                  Purchase credits as needed. Only pay for what you use with no commitments.{' '}
                  <a
                    href="https://app.kilo.ai/credits"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    Learn more
                  </a>
                </p>
              </div>

              {/* Bring Your Own Key */}
              <div className="rounded-md border border-gray-600 bg-gray-900/50 p-3">
                <h4 className="text-sm font-medium text-white">Bring Your Own Key</h4>
                <p className="mt-1 text-xs text-gray-400">
                  Use API keys from your existing AI provider accounts.{' '}
                  <a
                    href="https://kilo.ai/docs/getting-started/byok"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    Learn more
                  </a>
                </p>
              </div>
            </div>
          </div>

          <div className="text-center">
            <a
              href="mailto:sales@kilocode.ai"
              className="text-sm text-gray-400 hover:text-blue-400"
            >
              Questions? Contact Support.
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
