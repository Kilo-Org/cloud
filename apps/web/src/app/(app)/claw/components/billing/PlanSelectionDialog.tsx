'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Crown, Server, TriangleAlert, Wallet, ChevronRight } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import {
  createKiloClawSignupDisplay,
  formatKiloClawFirstChargeLabel,
  formatMicrodollars,
  isKiloClawStandardIntroCost,
  PLAN_COST_MICRODOLLARS,
  type ClawPlan,
  type KiloClawSignupDisplay,
  type KiloPassUpsellActivationPreview,
} from './billing-types';
import { KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF } from '@/lib/kilo-pass/constants';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type Cadence = 'monthly' | 'yearly';
type Tier = '19' | '49' | '199';

type PlanSelectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const TIER_DATA: Record<
  Tier,
  { name: string; monthlyPrice: number; yearlyPrice: number; monthlyCredits: number }
> = {
  '19': { name: 'Starter', monthlyPrice: 19, yearlyPrice: 228, monthlyCredits: 19 },
  '49': { name: 'Pro', monthlyPrice: 49, yearlyPrice: 588, monthlyCredits: 49 },
  '199': { name: 'Expert', monthlyPrice: 199, yearlyPrice: 2388, monthlyCredits: 199 },
};

const TIERS: Tier[] = ['19', '49', '199'];

function isCommitAvailable(tier: Tier | null, cadence: Cadence): boolean {
  if (!tier) return false;
  if (cadence === 'yearly') return true;
  // Monthly: commit needs $48, so only Pro ($49) and Expert ($199) qualify
  return tier === '49' || tier === '199';
}

function CadenceToggle({
  cadence,
  onChange,
}: {
  cadence: Cadence;
  onChange: (c: Cadence) => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
      <span className="text-muted-foreground text-xs">Billing cadence</span>
      <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
        <button
          type="button"
          onClick={() => onChange('monthly')}
          className={cn(
            'rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition-all',
            cadence === 'monthly'
              ? 'bg-blue-600 text-white'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => onChange('yearly')}
          className={cn(
            'rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition-all',
            cadence === 'yearly'
              ? 'bg-blue-600 text-white'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Yearly
        </button>
      </div>
    </div>
  );
}

function TierCard({
  tier,
  cadence,
  isSelected,
  onSelect,
}: {
  tier: Tier;
  cadence: Cadence;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const data = TIER_DATA[tier];
  const isYearly = cadence === 'yearly';
  const price = isYearly ? data.yearlyPrice : data.monthlyPrice;
  const priceSuffix = isYearly ? '/year' : '/month';
  const creditsLabel = isYearly
    ? `$${data.yearlyPrice}/year paid credits`
    : `$${data.monthlyPrice}/month paid credits`;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative rounded-xl border p-4 text-left transition-all',
        isSelected
          ? 'border-blue-500 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]'
          : 'border-border bg-secondary hover:border-blue-500/30 hover:shadow-[0_0_0_1px_rgba(59,130,246,0.15)]'
      )}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-semibold">{data.name}</span>
        <span className="text-[11px] text-neutral-500">{isYearly ? 'Yearly' : 'Monthly'}</span>
      </div>

      <div className="text-2xl font-bold">
        ${price}
        <span className="text-muted-foreground text-[13px] font-normal">{priceSuffix}</span>
      </div>

      <div className="mt-3 space-y-0.5">
        <div className="text-muted-foreground text-xs leading-relaxed">
          <span className="text-amber-300">{creditsLabel}</span>
        </div>
        <div className="text-muted-foreground text-xs leading-relaxed">
          Up to <span className="text-emerald-300">40%</span> free bonus credits
        </div>
        <div className="text-xs leading-relaxed text-emerald-300">
          First 2 months: +50% free bonus credits
        </div>
      </div>

      <div className="mt-3.5 flex justify-end">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] font-semibold transition-all',
            isSelected
              ? 'border-blue-500 bg-blue-600 text-white'
              : 'border-blue-500/30 bg-blue-500/10 text-blue-300 hover:border-blue-500 hover:bg-blue-500/20 hover:text-white'
          )}
        >
          {isSelected ? (
            <>
              <Check className="h-3.5 w-3.5" /> Selected
            </>
          ) : (
            'Select →'
          )}
        </span>
      </div>
    </button>
  );
}

function HostingRadioGroup({
  hostingPlan,
  onSelect,
  commitDisabled,
  signupDisplay,
}: {
  hostingPlan: ClawPlan | null;
  onSelect: (plan: ClawPlan) => void;
  commitDisabled: boolean;
  signupDisplay: KiloClawSignupDisplay;
}) {
  return (
    <div className="mb-4">
      <div className="text-muted-foreground mb-2 text-xs font-medium">
        Hosting plan for this KiloClaw instance:
      </div>

      <button
        type="button"
        disabled={commitDisabled}
        onClick={() => onSelect('commit')}
        className={cn(
          'mb-1.5 flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2.5 transition-all',
          commitDisabled && 'pointer-events-none opacity-35',
          hostingPlan === 'commit'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-border hover:border-neutral-500'
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
            hostingPlan === 'commit' ? 'border-blue-500' : 'border-neutral-500'
          )}
        >
          {hostingPlan === 'commit' && <span className="h-2 w-2 rounded-full bg-blue-500" />}
        </span>
        <span className="text-[13px] font-medium">Commit plan</span>
        <span className="text-muted-foreground ml-auto text-xs">
          {signupDisplay.commit.primaryPrice}
          {signupDisplay.commit.priceDetail}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onSelect('standard')}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2.5 transition-all',
          hostingPlan === 'standard'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-border hover:border-neutral-500'
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
            hostingPlan === 'standard' ? 'border-blue-500' : 'border-neutral-500'
          )}
        >
          {hostingPlan === 'standard' && <span className="h-2 w-2 rounded-full bg-blue-500" />}
        </span>
        <span className="text-[13px] font-medium">Standard plan</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          {signupDisplay.standard.introDetail ? (
            <>
              <span className="font-medium text-emerald-400">
                {signupDisplay.standard.primaryPrice} {signupDisplay.standard.priceDetail}
              </span>
              <span className="text-muted-foreground">{signupDisplay.standard.introDetail}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {signupDisplay.standard.primaryPrice}/month
            </span>
          )}
        </span>
      </button>

      {commitDisabled && (
        <p className="text-muted-foreground mt-1 pl-0.5 text-[11px]">
          Commit plan requires {signupDisplay.commit.primaryPrice} in credits. Choose a tier that
          covers the first charge.
        </p>
      )}
    </div>
  );
}

function HostingOnlyPlanCard({
  plan,
  isSelected,
  onSelect,
  signupDisplay,
}: {
  plan: ClawPlan;
  isSelected: boolean;
  onSelect: () => void;
  signupDisplay: KiloClawSignupDisplay;
}) {
  const isCommit = plan === 'commit';
  const display = isCommit ? signupDisplay.commit : signupDisplay.standard;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative rounded-lg border-2 p-3.5 text-center transition-all',
        isSelected ? 'border-blue-500 bg-blue-500/10' : 'border-border hover:border-neutral-500'
      )}
    >
      <div className="text-sm font-semibold">{isCommit ? 'Commit' : 'Standard'}</div>
      <div className="mt-1 text-[22px] font-bold">
        {display.primaryPrice}
        <span className="text-muted-foreground text-xs font-normal">{display.priceDetail}</span>
      </div>
      {display.introDetail ? (
        <div className="mt-0.5 text-[11px] font-medium text-emerald-400">{display.introDetail}</div>
      ) : (
        <div className="text-muted-foreground mt-0.5 text-[11px]">
          {isCommit ? signupDisplay.commit.monthlyEquivalent : 'Billed monthly'}
        </div>
      )}
    </button>
  );
}

function CreditsHowItWorks() {
  const [open, setOpen] = useState(false);
  const showTwoMonthPromo = dayjs().utc().isBefore(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF);

  return (
    <div className="border-border/50 mb-3.5 overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        How credits work
      </button>
      {open && (
        <div className="space-y-1 px-3.5 pb-3">
          <div className="text-muted-foreground flex items-start gap-2 py-0.5 text-xs">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>Your payment converts 1:1 into paid credits that never expire</span>
          </div>
          <div className="text-muted-foreground flex items-start gap-2 py-0.5 text-xs">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>
              Earn free bonus credits after using your paid credits each month. Unused bonus credits
              expire monthly.
            </span>
          </div>
          {showTwoMonthPromo ? (
            <div className="text-muted-foreground flex items-start gap-2 py-0.5 text-xs">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                First-time subscribers receive <span className="text-emerald-300">50%</span> free
                bonus credits for the first two months.
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CreditEnrollmentSection({
  selectedPlan,
  rawCreditBalanceMicrodollars,
  effectiveBalanceMicrodollars,
  projectedKiloPassBonusMicrodollars,
  costMicrodollars,
  onEnroll,
  isPending,
}: {
  selectedPlan: ClawPlan;
  rawCreditBalanceMicrodollars: number;
  effectiveBalanceMicrodollars: number;
  projectedKiloPassBonusMicrodollars: number;
  costMicrodollars: number;
  onEnroll: () => void;
  isPending: boolean;
}) {
  const priceLabel = formatKiloClawFirstChargeLabel({ plan: selectedPlan, costMicrodollars });
  const isIntro = selectedPlan === 'standard' && isKiloClawStandardIntroCost({ costMicrodollars });
  const hasProjectedBonus = projectedKiloPassBonusMicrodollars > 0;
  const hasSufficientBalance = effectiveBalanceMicrodollars >= costMicrodollars;
  const shortfall = Math.max(0, costMicrodollars - effectiveBalanceMicrodollars);
  const planLabel = selectedPlan === 'commit' ? 'Commit' : 'Standard';

  if (hasSufficientBalance) {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Wallet className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold text-emerald-300">Pay with credits</span>
        </div>
        <p className="text-muted-foreground mb-1 text-sm">
          {planLabel} Plan — {priceLabel} from your credit balance
        </p>
        {hasProjectedBonus ? (
          <div className="mb-3 space-y-1 text-xs text-emerald-400/80">
            <p>Current balance: {formatMicrodollars(rawCreditBalanceMicrodollars)}</p>
            <p>
              Projected Kilo Pass bonus for this charge:{' '}
              {formatMicrodollars(projectedKiloPassBonusMicrodollars)}
            </p>
            <p>Effective balance: {formatMicrodollars(effectiveBalanceMicrodollars)}</p>
          </div>
        ) : (
          <p className="mb-3 text-xs text-emerald-400/80">
            Balance: {formatMicrodollars(rawCreditBalanceMicrodollars)}
          </p>
        )}
        <Button
          onClick={onEnroll}
          disabled={isPending}
          variant="primary"
          className="w-full py-3 font-semibold"
        >
          {isPending ? 'Activating…' : `Pay ${formatMicrodollars(costMicrodollars)} with Credits`}
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-amber-300">Insufficient credits</span>
      </div>
      <div className="text-muted-foreground space-y-1 text-sm">
        <div className="flex justify-between">
          <span>Balance</span>
          <span className="text-foreground">
            {formatMicrodollars(rawCreditBalanceMicrodollars)}
          </span>
        </div>
        {hasProjectedBonus && (
          <div className="flex justify-between">
            <span>Projected Kilo Pass bonus</span>
            <span className="text-foreground">
              {formatMicrodollars(projectedKiloPassBonusMicrodollars)}
            </span>
          </div>
        )}
        {hasProjectedBonus && (
          <div className="flex justify-between">
            <span>Effective balance</span>
            <span className="text-foreground">
              {formatMicrodollars(effectiveBalanceMicrodollars)}
            </span>
          </div>
        )}
        <div className="flex justify-between">
          <span>
            {planLabel} plan cost{isIntro ? ' (first month)' : ''}
          </span>
          <span className="text-foreground">{formatMicrodollars(costMicrodollars)}</span>
        </div>
        <div className="flex justify-between border-t border-amber-500/20 pt-1 font-medium text-amber-400">
          <span>Shortfall</span>
          <span>{formatMicrodollars(shortfall)}</span>
        </div>
      </div>
      <Link
        href="/credits"
        className="mt-3 block text-center text-sm font-medium text-blue-400 hover:text-blue-300"
      >
        Add credits to your balance
      </Link>
    </div>
  );
}

function KiloPassUpsellInsufficiencyNotice({
  plan,
  preview,
}: {
  plan: ClawPlan;
  preview: KiloPassUpsellActivationPreview;
}) {
  const planLabel = plan === 'commit' ? 'Commit' : 'Standard';
  const hasProjectedBonus = preview.projectedKiloPassBonusMicrodollars > 0;

  return (
    <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-sm font-semibold text-amber-300">
          This Kilo Pass selection can&apos;t auto-activate {planLabel} hosting.
        </span>
      </div>
      <div className="text-muted-foreground space-y-1 text-xs">
        <div className="flex justify-between gap-3">
          <span>First Kilo Pass base credits</span>
          <span className="text-foreground">
            {formatMicrodollars(preview.projectedKiloPassBaseMicrodollars)}
          </span>
        </div>
        {hasProjectedBonus ? (
          <div className="flex justify-between gap-3">
            <span>Projected Kilo Pass bonus</span>
            <span className="text-foreground">
              {formatMicrodollars(preview.projectedKiloPassBonusMicrodollars)}
            </span>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <span>Effective credits after checkout</span>
          <span className="text-foreground">
            {formatMicrodollars(preview.effectiveBalanceMicrodollars)}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span>{planLabel} first charge</span>
          <span className="text-foreground">{formatMicrodollars(preview.costMicrodollars)}</span>
        </div>
        <div className="flex justify-between gap-3 border-t border-amber-500/20 pt-1 font-medium text-amber-300">
          <span>Shortfall</span>
          <span>{formatMicrodollars(preview.shortfallMicrodollars)}</span>
        </div>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Choose a larger Kilo Pass tier or add credits before starting auto-activation.
      </p>
    </div>
  );
}

export function PlanSelectionDialog({ open, onOpenChange }: PlanSelectionDialogProps) {
  // Kilo Pass state
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [hostingPlan, setHostingPlan] = useState<ClawPlan | null>(null);

  // Hosting Only state
  const [hostingOnlyPlan, setHostingOnlyPlan] = useState<ClawPlan | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: billing, isPending: billingSummaryPending } = useQuery(
    trpc.kiloclaw.getPersonalBillingSummary.queryOptions()
  );
  const checkout = useMutation(trpc.kiloclaw.createSubscriptionCheckout.mutationOptions());
  const kiloPassUpsell = useMutation(
    trpc.kiloclaw.createKiloPassUpsellCheckout.mutationOptions({
      onSuccess: data => {
        if (data.url) window.location.href = data.url;
      },
    })
  );
  const enrollWithCredits = useMutation(
    trpc.kiloclaw.enrollWithCredits.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getActivePersonalBillingStatus.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getPersonalBillingSummary.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getStatus.queryKey(),
        });
        toast.success('Subscription activated with credits');
        onOpenChange(false);
      },
    })
  );

  const creditBalance = billing?.creditBalanceMicrodollars ?? null;
  const hasCredits = creditBalance !== null && creditBalance > 0;
  const hasActiveKiloPass = billing?.hasActiveKiloPass ?? false;
  const creditEnrollmentPreview = billing?.creditEnrollmentPreview ?? null;
  const kiloPassUpsellPreview = billing?.kiloPassUpsellPreview ?? null;
  const activeInstanceId = billing?.activeInstanceId ?? null;
  const showKiloPassUpsell = !hasActiveKiloPass;
  const signupDisplay = createKiloClawSignupDisplay({
    standardCostMicrodollars:
      creditEnrollmentPreview?.standard.costMicrodollars ?? PLAN_COST_MICRODOLLARS.standard,
    commitCostMicrodollars:
      creditEnrollmentPreview?.commit.costMicrodollars ?? PLAN_COST_MICRODOLLARS.commit,
  });
  const selectedCreditEnrollmentPreview =
    hostingOnlyPlan !== null ? (creditEnrollmentPreview?.[hostingOnlyPlan] ?? null) : null;
  const showCreditEnrollment =
    !!selectedCreditEnrollmentPreview && (hasCredits || hasActiveKiloPass);

  const hostingOnlyActive = hostingOnlyPlan !== null;
  const selectedKiloPassPreview =
    selectedTier !== null && hostingPlan !== null
      ? (kiloPassUpsellPreview?.[hostingPlan]?.[cadence]?.[selectedTier] ?? null)
      : null;
  const selectedKiloPassPreviewLoading =
    billingSummaryPending &&
    selectedTier !== null &&
    hostingPlan !== null &&
    selectedKiloPassPreview === null;
  const selectedKiloPassInsufficient = selectedKiloPassPreview?.eligible === false;
  const selectedCommitPreview =
    selectedTier !== null
      ? (kiloPassUpsellPreview?.commit?.[cadence]?.[selectedTier] ?? null)
      : null;
  const commitPreviewLoading = selectedTier !== null && selectedCommitPreview === null;
  const commitDisabled = selectedCommitPreview
    ? !selectedCommitPreview.eligible
    : commitPreviewLoading || !isCommitAvailable(selectedTier, cadence);

  function isCommitEligibleForSelection(tier: Tier | null, selectedCadence: Cadence) {
    if (!tier) return false;
    const preview = kiloPassUpsellPreview?.commit?.[selectedCadence]?.[tier] ?? null;
    return preview ? preview.eligible : false;
  }

  // When cadence or tier changes, reset hosting if commit becomes unavailable
  function handleCadenceChange(newCadence: Cadence) {
    setCadence(newCadence);
    if (hostingPlan === 'commit' && !isCommitEligibleForSelection(selectedTier, newCadence)) {
      setHostingPlan('standard');
    }
  }

  function handleTierSelect(tier: Tier) {
    setSelectedTier(tier);
    setHostingOnlyPlan(null); // mutual exclusion
    if (hostingPlan === 'commit' && !isCommitEligibleForSelection(tier, cadence)) {
      setHostingPlan('standard');
    }
  }

  function handleHostingPlanSelect(plan: ClawPlan) {
    setHostingPlan(plan);
    setHostingOnlyPlan(null); // mutual exclusion
  }

  function handleHostingOnlySelect(plan: ClawPlan) {
    setHostingOnlyPlan(plan);
    setSelectedTier(null); // mutual exclusion
    setHostingPlan(null);
  }

  async function handleKiloPassCheckout() {
    if (!selectedTier || !hostingPlan) return;
    try {
      await kiloPassUpsell.mutateAsync({
        tier: selectedTier,
        cadence,
        hostingPlan,
        ...(activeInstanceId ? { instanceId: activeInstanceId } : {}),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start checkout. Please try again.';
      toast.error(message, { duration: 10000 });
    }
  }

  async function handleHostingOnlyCheckout() {
    if (!hostingOnlyPlan) return;
    try {
      const result = await checkout.mutateAsync({
        plan: hostingOnlyPlan,
        ...(activeInstanceId ? { instanceId: activeInstanceId } : {}),
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start checkout. Please try again.';
      toast.error(message, { duration: 10000 });
    }
  }

  async function handleEnrollWithCredits() {
    if (!hostingOnlyPlan) return;
    try {
      await enrollWithCredits.mutateAsync({
        plan: hostingOnlyPlan,
        ...(activeInstanceId ? { instanceId: activeInstanceId } : {}),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to activate with credits. Please try again.';
      toast.error(message, { duration: 10000 });
    }
  }

  const kiloPassReady =
    selectedKiloPassPreview?.eligible === true ||
    (!billingSummaryPending &&
      selectedTier !== null &&
      hostingPlan !== null &&
      selectedKiloPassPreview === null);
  const kiloPassButtonLabel = selectedKiloPassPreviewLoading
    ? 'Checking credits…'
    : selectedKiloPassInsufficient
      ? 'Choose a larger tier or add credits'
      : kiloPassReady
        ? 'Get Kilo Pass + Hosting'
        : 'Select a tier and hosting plan';

  const hostingOnlyCostMicrodollars = hostingOnlyPlan
    ? (selectedCreditEnrollmentPreview?.costMicrodollars ?? PLAN_COST_MICRODOLLARS[hostingOnlyPlan])
    : null;
  const hostingOnlyLabel =
    hostingOnlyPlan && hostingOnlyCostMicrodollars !== null
      ? `Subscribe to ${hostingOnlyPlan === 'commit' ? 'Commit' : 'Standard'} plan, ${formatKiloClawFirstChargeLabel({ plan: hostingOnlyPlan, costMicrodollars: hostingOnlyCostMicrodollars })}`
      : 'Select a plan above';
  const hostingSectionTitle = hasActiveKiloPass ? 'Choose a hosting plan' : 'Hosting only';
  const hostingSectionDescription = hasActiveKiloPass
    ? 'You already have Kilo Pass. Choose a hosting plan and fund it from your credit balance or pay directly via Stripe.'
    : 'Pay for hosting directly via Stripe. You can buy credits separately for AI inference.';
  const highlightHostingSection = hasActiveKiloPass || hostingOnlyActive;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={true} className="sm:max-w-2xl">
        <div className="max-h-[85vh] space-y-4 overflow-y-auto pr-1">
          <div className="text-center">
            <DialogTitle className="text-foreground text-2xl font-bold">
              Choose Your KiloClaw Subscription
            </DialogTitle>
            <p className="text-muted-foreground mt-2">
              Choose how to activate hosting for this instance
            </p>
          </div>

          {showKiloPassUpsell && (
            <>
              {/* Section 1: Kilo Pass (Recommended) */}
              <div
                className={cn(
                  'rounded-xl border p-5 transition-all',
                  'border-blue-500/30 bg-gradient-to-b from-blue-500/[0.04] to-transparent shadow-[0_0_0_1px_rgba(59,130,246,0.08)]'
                )}
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <Crown className="h-5 w-5 text-amber-400" />
                  <h3 className="flex-1 text-base font-semibold">Activate with Kilo Pass</h3>
                  <Badge className="rounded-full border-transparent bg-blue-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-blue-300 ring-1 ring-blue-500/30">
                    Recommended
                  </Badge>
                </div>

                <p className="text-muted-foreground mb-4 text-[13px]">
                  Credits for KiloClaw hosting + AI inference. Earn up to{' '}
                  <span className="text-emerald-300">50% free bonus credits</span>.
                </p>

                <CadenceToggle cadence={cadence} onChange={handleCadenceChange} />

                {/* Tier cards */}
                <div className="mb-3.5 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-2.5">
                  {TIERS.map(tier => (
                    <TierCard
                      key={tier}
                      tier={tier}
                      cadence={cadence}
                      isSelected={selectedTier === tier}
                      onSelect={() => handleTierSelect(tier)}
                    />
                  ))}
                </div>

                <CreditsHowItWorks />

                {/* Warning */}
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <p className="text-xs leading-relaxed text-amber-300">
                    Kilo Pass is a <strong className="font-normal">credits subscription</strong>.
                    Hosting is charged as a credit deduction from your balance. Cancelling Kilo Pass
                    does <strong className="font-normal">not</strong> cancel KiloClaw hosting.
                  </p>
                </div>

                {/* Hosting plan radios */}
                {selectedTier && (
                  <HostingRadioGroup
                    hostingPlan={hostingPlan}
                    onSelect={handleHostingPlanSelect}
                    commitDisabled={commitDisabled}
                    signupDisplay={signupDisplay}
                  />
                )}

                {selectedKiloPassInsufficient && selectedKiloPassPreview && hostingPlan && (
                  <KiloPassUpsellInsufficiencyNotice
                    plan={hostingPlan}
                    preview={selectedKiloPassPreview}
                  />
                )}

                <Button
                  onClick={handleKiloPassCheckout}
                  disabled={!kiloPassReady || kiloPassUpsell.isPending}
                  variant="primary"
                  className="w-full py-3.5 text-base font-semibold"
                >
                  {kiloPassUpsell.isPending ? 'Redirecting to Stripe…' : kiloPassButtonLabel}
                </Button>
                <p className="text-muted-foreground mt-2 text-center text-xs">
                  You&apos;ll be redirected to Stripe to pay for Kilo Pass
                </p>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs uppercase tracking-wider">
                  or pay for KiloClaw hosting only
                </span>
                <div className="bg-border h-px flex-1" />
              </div>
            </>
          )}

          {/* Section 2: Hosting selection / standalone checkout */}
          <div
            className={cn(
              'rounded-xl border p-5 transition-all',
              highlightHostingSection
                ? 'border-border opacity-100'
                : 'border-border/50 opacity-70 hover:opacity-90 hover:border-border'
            )}
          >
            <div className="mb-3 flex items-center gap-2.5">
              <Server className="text-muted-foreground h-[18px] w-[18px]" />
              <h3 className="text-base font-semibold">{hostingSectionTitle}</h3>
            </div>

            <p className="text-muted-foreground mb-3.5 text-[13px]">{hostingSectionDescription}</p>

            <div className="mb-4 grid grid-cols-2 gap-2">
              <HostingOnlyPlanCard
                plan="commit"
                isSelected={hostingOnlyPlan === 'commit'}
                onSelect={() => handleHostingOnlySelect('commit')}
                signupDisplay={signupDisplay}
              />
              <HostingOnlyPlanCard
                plan="standard"
                isSelected={hostingOnlyPlan === 'standard'}
                onSelect={() => handleHostingOnlySelect('standard')}
                signupDisplay={signupDisplay}
              />
            </div>

            {/* Credit enrollment option — shown when a hosting plan is selected and credits are available or Kilo Pass is active */}
            {showCreditEnrollment && hostingOnlyPlan && (
              <>
                <CreditEnrollmentSection
                  selectedPlan={hostingOnlyPlan}
                  rawCreditBalanceMicrodollars={creditBalance ?? 0}
                  effectiveBalanceMicrodollars={
                    selectedCreditEnrollmentPreview.effectiveBalanceMicrodollars
                  }
                  projectedKiloPassBonusMicrodollars={
                    selectedCreditEnrollmentPreview.projectedKiloPassBonusMicrodollars
                  }
                  costMicrodollars={selectedCreditEnrollmentPreview.costMicrodollars}
                  onEnroll={handleEnrollWithCredits}
                  isPending={enrollWithCredits.isPending}
                />
                <div className="my-3 flex items-center gap-3">
                  <div className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground text-xs">or pay with Stripe</span>
                  <div className="bg-border h-px flex-1" />
                </div>
              </>
            )}

            <Button
              onClick={handleHostingOnlyCheckout}
              disabled={!hostingOnlyPlan || checkout.isPending}
              variant="outline"
              className="w-full"
            >
              {checkout.isPending ? 'Redirecting to Stripe…' : hostingOnlyLabel}
            </Button>
            <p className="text-muted-foreground mt-2 text-center text-xs">
              You&apos;ll be redirected to Stripe to pay
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
