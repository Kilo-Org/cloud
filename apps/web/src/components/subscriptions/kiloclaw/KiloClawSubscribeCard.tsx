'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import {
  createKiloClawSignupDisplay,
  PLAN_COST_MICRODOLLARS,
  type KiloClawSignupDisplay,
} from '@/app/(app)/claw/components/billing/billing-types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type KiloClawSubscribeCardProps = {
  standardCostMicrodollars?: number;
  commitCostMicrodollars?: number;
  hasActiveKiloPass: boolean;
};

type KiloClawPlanCardProps = {
  title: string;
  cadenceLabel: string;
  badge?: string;
  price: string;
  priceDetail?: string;
  details: string[];
  accentDetail?: string;
  ctaLabel: string;
  isRecommended?: boolean;
};

function KiloClawPlanCard({
  title,
  cadenceLabel,
  badge,
  price,
  priceDetail,
  details,
  accentDetail,
  ctaLabel,
  isRecommended = false,
}: KiloClawPlanCardProps) {
  return (
    <div
      className={cn(
        'group bg-background relative flex h-full flex-col rounded-xl border p-4 text-left transition-colors',
        'hover:border-blue-400/70 hover:shadow-[0_0_0_1px_rgba(59,130,246,0.25)]',
        isRecommended
          ? 'border-blue-500/60 shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
          : 'border-border/70'
      )}
    >
      {isRecommended && badge ? (
        <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 text-white">
          {badge}
        </Badge>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{title}</div>
        </div>
        <div className="flex items-center gap-2">
          {!isRecommended && badge ? <Badge variant="secondary-outline">{badge}</Badge> : null}
          <div className="text-muted-foreground mt-0.5 text-xs">{cadenceLabel}</div>
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-1">
        <div className="text-2xl font-semibold text-white">{price}</div>
        {priceDetail ? <div className="text-muted-foreground text-xs">{priceDetail}</div> : null}
      </div>

      <div className="mt-4 flex-1 space-y-2">
        {details.map(detail => (
          <div
            key={detail}
            className="text-muted-foreground flex items-start gap-2 text-xs leading-5"
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{detail}</span>
          </div>
        ))}
        {accentDetail ? (
          <div className="flex items-start gap-2 text-xs leading-5 text-emerald-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{accentDetail}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-end pt-2">
        <Link
          href="/claw"
          className={cn(
            'inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-500/10 px-4 py-1.5 text-sm font-semibold text-blue-100 transition',
            'hover:border-blue-400 hover:bg-blue-500/20 hover:text-white',
            'focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2 focus-visible:outline-none'
          )}
        >
          {ctaLabel}
          <span className="text-base">→</span>
        </Link>
      </div>
    </div>
  );
}

export function KiloClawSubscribeCard({
  standardCostMicrodollars = PLAN_COST_MICRODOLLARS.standard,
  commitCostMicrodollars = PLAN_COST_MICRODOLLARS.commit,
  hasActiveKiloPass,
}: KiloClawSubscribeCardProps) {
  const signupDisplay: KiloClawSignupDisplay = createKiloClawSignupDisplay({
    standardCostMicrodollars,
    commitCostMicrodollars,
  });
  const standardDetails = [
    'Month-to-month hosting for one personal KiloClaw instance.',
    signupDisplay.standard.accessoryDetail,
    hasActiveKiloPass
      ? 'Use Kilo Pass credits during activation or pay directly with Stripe.'
      : 'Activate and manage the instance inside KiloClaw.',
  ];

  const commitDetails = [
    'Six-month hosting commitment for one personal KiloClaw instance.',
    signupDisplay.commit.accessoryDetail,
    signupDisplay.commit.monthlyEquivalent,
    hasActiveKiloPass
      ? 'Works when your Kilo Pass balance can cover the first commit charge.'
      : 'Best for steady usage when you want the lower effective monthly rate.',
  ];

  const benefits = [
    'Choose a plan in KiloClaw when you are ready to activate a personal instance.',
    hasActiveKiloPass
      ? 'Your active Kilo Pass can fund hosting from credits or you can still pay with Stripe.'
      : 'You can start with hosting only and add Kilo Pass later for AI credits and bonus ramps.',
    'Each subscription is tied to a specific KiloClaw instance, so activation happens inside KiloClaw.',
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:gap-5">
        <KiloClawPlanCard
          title="Standard"
          cadenceLabel="Monthly"
          price={signupDisplay.standard.primaryPrice}
          priceDetail={
            signupDisplay.standard.introDetail
              ? `${signupDisplay.standard.priceDetail}, ${signupDisplay.standard.introDetail}`
              : signupDisplay.standard.priceDetail
          }
          details={standardDetails}
          accentDetail={
            signupDisplay.standard.introDetail
              ? `${signupDisplay.standard.primaryPrice} intro price preserved for this live lineage.`
              : undefined
          }
          ctaLabel="Sign up in KiloClaw"
        />
        <KiloClawPlanCard
          title="Commit"
          cadenceLabel="6 months"
          badge="Best value"
          price={signupDisplay.commit.primaryPrice}
          priceDetail={signupDisplay.commit.priceDetail}
          details={commitDetails}
          ctaLabel="Sign up in KiloClaw"
          isRecommended
        />
      </div>

      <div className="space-y-2 text-xs">
        {benefits.map(benefit => (
          <div key={benefit} className="text-muted-foreground flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{benefit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
