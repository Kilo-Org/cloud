'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  useOrganizationSeatUsage,
  useOrganizationSubscriptionLink,
  useResubscribeDefaults,
} from '@/app/api/organizations/hooks';
import { PlanCard } from '@/components/organizations/subscription/PlanCard';
import {
  ENTERPRISE_FEATURES,
  TEAMS_FEATURES,
} from '@/components/organizations/subscription/plan-features';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { seatPrice } from '@/lib/organizations/constants';
import type { BillingCycle, OrganizationPlan } from '@/lib/organizations/organization-types';
import { cn } from '@/lib/utils';

const BILLING_CADENCE_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
] as const satisfies ReadonlyArray<{ value: BillingCycle; label: string }>;

export function SeatsSubscribeCard({
  organizationId,
  currentPlan,
}: {
  organizationId: string;
  currentPlan: OrganizationPlan;
}) {
  const [selectedPlan, setSelectedPlan] = useState<OrganizationPlan>(currentPlan);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('annual');
  const [seatCount, setSeatCount] = useState<number | null>(null);
  const seededFromDefaults = useRef(false);
  const hog = usePostHog();

  const seatUsageQuery = useOrganizationSeatUsage(organizationId);
  const resubscribeDefaultsQuery = useResubscribeDefaults(organizationId);
  const subscriptionLink = useOrganizationSubscriptionLink();

  useEffect(() => {
    setSelectedPlan(currentPlan);
  }, [currentPlan]);

  useEffect(() => {
    if (seededFromDefaults.current) return;

    const seatUsage = seatUsageQuery.data;
    const resubscribeDefaults = resubscribeDefaultsQuery.data;
    if (!seatUsage || !resubscribeDefaults) return;

    seededFromDefaults.current = true;
    setBillingCycle(resubscribeDefaults.billingCycle);
    setSeatCount(Math.max(resubscribeDefaults.defaultSeatCount, seatUsage.usedSeats));
  }, [resubscribeDefaultsQuery.data, seatUsageQuery.data]);

  const defaultSeatCount = Math.max(1, Math.min(100, seatUsageQuery.data?.usedSeats ?? 1));
  const effectiveSeatCount = seatCount ?? defaultSeatCount;
  const selectedPlanName = selectedPlan === 'teams' ? 'Teams' : 'Enterprise';
  const isPending = subscriptionLink.isPending;

  async function handlePurchase() {
    hog?.capture('trial_upgrade_purchase_clicked', {
      organizationId,
      selectedPlan,
      billingCycle,
      seatCount: effectiveSeatCount,
      source: 'subscriptions_page',
    });

    try {
      const result = await subscriptionLink.mutateAsync({
        organizationId,
        seats: effectiveSeatCount,
        cancelUrl: window.location.href,
        plan: selectedPlan,
        billingCycle,
      });

      if (!result.url) {
        toast.error('Failed to create Stripe checkout session');
        return;
      }

      window.location.href = result.url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start checkout');
    }
  }

  const decrementDisabled = effectiveSeatCount <= 1 || isPending;
  const incrementDisabled = effectiveSeatCount >= 100 || isPending;
  const purchaseDisabled = isPending || seatUsageQuery.data == null;

  return (
    <Card className="border-border/60 w-full overflow-hidden rounded-xl shadow-sm">
      <CardContent className="grid gap-5 p-5 md:p-6">
        <div className="bg-muted/20 border-border/60 flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-lg border px-3 py-2">
          <div className="text-sm font-medium">Choose plan and billing cadence</div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
              {BILLING_CADENCE_OPTIONS.map(option => (
                <Button
                  key={option.value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    seededFromDefaults.current = true;
                    setBillingCycle(option.value);
                  }}
                  className={cn(
                    'h-8 min-w-24 rounded-md px-3 text-xs font-semibold transition',
                    billingCycle === option.value
                      ? 'bg-blue-500 text-white hover:bg-blue-500'
                      : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                  )}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-semibold transition-[opacity,text-decoration-color]',
                billingCycle === 'annual'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 opacity-100'
                  : 'border-border/60 text-muted-foreground opacity-70 line-through decoration-current'
              )}
            >
              Save 17%
            </span>
          </div>
        </div>

        <div className="mt-4 grid gap-5 lg:grid-cols-2 lg:gap-6">
          <PlanCard
            plan="teams"
            pricePerMonth={seatPrice('teams', billingCycle)}
            billingCycle={billingCycle}
            features={TEAMS_FEATURES}
            isSelected={selectedPlan === 'teams'}
            currentPlan={currentPlan}
            onSelect={() => setSelectedPlan('teams')}
          />

          <PlanCard
            plan="enterprise"
            pricePerMonth={seatPrice('enterprise', billingCycle)}
            billingCycle={billingCycle}
            features={ENTERPRISE_FEATURES}
            isSelected={selectedPlan === 'enterprise'}
            currentPlan={currentPlan}
            onSelect={() => setSelectedPlan('enterprise')}
          />
        </div>

        <div className="bg-muted/5 rounded-xl p-3 md:p-4">
          <div className="flex flex-col items-center justify-center gap-3 text-center md:flex-row md:gap-4">
            <div className="text-base font-medium md:text-sm">Number of seats</div>

            <div className="flex flex-col items-center gap-2.5 md:flex-row md:gap-3">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={decrementDisabled}
                  onClick={() => {
                    seededFromDefaults.current = true;
                    setSeatCount(Math.max(1, effectiveSeatCount - 1));
                  }}
                  className="bg-background/80 h-11 w-11 rounded-xl px-0 text-sm hover:bg-background"
                >
                  <span className="text-lg leading-none">-</span>
                </Button>

                <Input
                  value={effectiveSeatCount}
                  inputMode="numeric"
                  disabled={isPending}
                  onChange={event => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    if (Number.isNaN(nextValue)) return;
                    seededFromDefaults.current = true;
                    setSeatCount(Math.max(1, Math.min(100, nextValue)));
                  }}
                  className="bg-blue-500/10 h-11 w-24 rounded-xl border-0 text-center text-lg font-semibold shadow-none focus-visible:border-transparent focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={incrementDisabled}
                  onClick={() => {
                    seededFromDefaults.current = true;
                    setSeatCount(Math.min(100, effectiveSeatCount + 1));
                  }}
                  className="bg-background/80 h-11 w-11 rounded-xl px-0 text-sm hover:bg-background"
                >
                  <span className="text-lg leading-none">+</span>
                </Button>
              </div>

              <div className="text-muted-foreground text-xs whitespace-nowrap md:text-[11px]">
                {seatUsageQuery.data
                  ? `(${seatUsageQuery.data.usedSeats} currently in use)`
                  : 'Checking current seat usage'}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex justify-center">
            <Button
              type="button"
              variant="primary"
              disabled={purchaseDisabled}
              onClick={() => void handlePurchase()}
              className="h-11 w-full max-w-xl text-sm font-semibold md:h-12 md:text-base"
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                `Purchase ${selectedPlanName} Plan`
              )}
            </Button>
          </div>

          <p className="text-muted-foreground text-center text-xs">
            You&apos;ll be redirected to Stripe to complete your purchase.
          </p>
        </div>

        <div className="border-border/40 bg-muted/6 rounded-xl border p-3.5 md:p-4">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-muted-foreground/80 text-[10px] font-semibold tracking-[0.14em] uppercase">
              Credits and model access
            </p>
            <h3 className="mt-1 text-sm font-medium leading-5 text-white/90">
              Credits are not included with seat subscriptions.
            </h3>
            <p className="text-muted-foreground/90 mt-1 text-xs leading-5">
              Pair Teams or Enterprise seats with the credit setup that fits your team.
            </p>
          </div>

          <div className="mt-3 grid gap-2.5 md:grid-cols-3">
            <div className="border-border/40 bg-background/35 rounded-xl border p-3">
              <h4 className="text-sm font-medium text-white/90">Kilo Pass</h4>
              <p className="text-muted-foreground/90 mt-1 text-xs leading-5">
                Credit subscription with bonus credits.{' '}
                <a
                  href="https://kilo.ai/features/kilo-pass"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400/90 hover:text-blue-300 hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>

            <div className="border-border/40 bg-background/35 rounded-xl border p-3">
              <h4 className="text-sm font-medium text-white/90">Pay-as-you-go</h4>
              <p className="text-muted-foreground/90 mt-1 text-xs leading-5">
                Purchase credits as needed. Only pay for what you use with no commitments.{' '}
                <Link
                  href="/credits"
                  className="text-blue-400/90 hover:text-blue-300 hover:underline"
                >
                  Learn more
                </Link>
              </p>
            </div>

            <div className="border-border/40 bg-background/35 rounded-xl border p-3">
              <h4 className="text-sm font-medium text-white/90">Bring Your Own Key</h4>
              <p className="text-muted-foreground/90 mt-1 text-xs leading-5">
                Use API keys from your existing AI provider accounts.{' '}
                <Link href="/byok" className="text-blue-400/90 hover:text-blue-300 hover:underline">
                  Learn more
                </Link>
              </p>
            </div>
          </div>

          <div className="mt-3 text-center">
            <a
              href="mailto:sales@kilocode.ai"
              className="text-muted-foreground/80 text-xs hover:text-muted-foreground"
            >
              Questions? Contact Support.
            </a>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
