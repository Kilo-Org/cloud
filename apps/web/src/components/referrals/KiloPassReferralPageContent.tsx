'use client';

import React, { type ReactNode } from 'react';
import Link from 'next/link';
import { CalendarDays, Gift, History, Info, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

const SHARE_WIDGET_ANCHOR_ID = 'kilo-pass-referral-share';

export type KiloPassReferralRewardStatus =
  | 'pending'
  | 'earned'
  | 'applied'
  | 'expired'
  | 'canceled'
  | 'reversed'
  | 'review_required';

export type KiloPassReferralRewardSummary = {
  totals: {
    totalRewards: number;
    pendingRewards: number;
    appliedRewards: number;
    totalRewardAmountUsd: number;
    pendingRewardAmountUsd: number;
    appliedRewardAmountUsd: number;
  };
  referrerCap: {
    grantedRewards: number;
    limit: number;
    reached: boolean;
  };
  rewards: Array<{
    id: string;
    role: 'referrer' | 'referee';
    status: KiloPassReferralRewardStatus;
    rewardAmountUsd: number;
    earnedAt: string;
    appliedAt: string | null;
    expiresAt: string | null;
    sourceTier: string | null;
    reviewReason: string | null;
  }>;
};

type KiloPassReferralPageContentProps = {
  summary: KiloPassReferralRewardSummary | null;
  isLoading?: boolean;
  errorMessage?: string | null;
  children?: ReactNode;
};

type StatusPresentation = {
  label: string;
  className: string;
};

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(amount: number): string {
  return usdFormatter.format(amount);
}

function formatTier(tier: string | null): string {
  switch (tier) {
    case 'tier_19':
      return '$19 monthly tier';
    case 'tier_49':
      return '$49 monthly tier';
    case 'tier_199':
      return '$199 monthly tier';
    default:
      return 'monthly tier';
  }
}

function roleLabel(role: 'referrer' | 'referee'): string {
  return role === 'referrer' ? 'Referral you shared' : 'Referral you used';
}

function rewardStatusPresentation(status: KiloPassReferralRewardStatus): StatusPresentation {
  switch (status) {
    case 'applied':
      return {
        label: 'Applied',
        className: 'bg-emerald-500/20 text-emerald-400 ring-emerald-500/20',
      };
    case 'earned':
    case 'pending':
      return {
        label: 'Waiting for a future eligible monthly issuance',
        className: 'bg-yellow-500/20 text-yellow-400 ring-yellow-500/20',
      };
    case 'expired':
      return {
        label: 'Expired',
        className: 'bg-zinc-500/20 text-zinc-400 ring-zinc-500/20',
      };
    case 'canceled':
      return {
        label: 'Canceled',
        className: 'bg-zinc-500/20 text-zinc-400 ring-zinc-500/20',
      };
    case 'reversed':
      return {
        label: 'Reversed',
        className: 'bg-red-500/20 text-red-400 ring-red-500/20',
      };
    case 'review_required':
      return {
        label: 'Needs review',
        className: 'bg-orange-500/20 text-orange-400 ring-orange-500/20',
      };
  }
}

export function KiloPassReferralPageContent({
  summary,
  isLoading = false,
  errorMessage,
  children,
}: KiloPassReferralPageContentProps) {
  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Gift className="size-4" aria-hidden="true" />
          Kilo Pass referrals
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Earn Kilo Pass referral bonuses</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Share Kilo Pass with someone else and when their first eligible monthly payment is
              confirmed, you both earn a 50% monthly Kilo Pass bonus based on their tier.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/subscriptions/kilo-pass">Back to Kilo Pass</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-6 p-6">
          <section
            id={SHARE_WIDGET_ANCHOR_ID}
            aria-label="Kilo Pass referral sharing"
            className="rounded-lg border border-border bg-input/30 p-4"
          >
            {children ?? (
              <output className="block text-sm text-muted-foreground">
                Loading Kilo Pass referral sharing…
              </output>
            )}
          </section>

          {isLoading ? (
            <output className="block border-t border-border pt-6 text-sm text-muted-foreground">
              Loading Kilo Pass referral rewards…
            </output>
          ) : errorMessage ? (
            <div className="border-t border-border pt-6">
              <Alert variant="destructive" role="alert">
                <AlertTitle>Kilo Pass referral rewards are unavailable</AlertTitle>
                <AlertDescription>{errorMessage || 'Try again in a minute.'}</AlertDescription>
              </Alert>
            </div>
          ) : summary ? (
            <KiloPassReferralSummary summary={summary} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function KiloPassReferralSummary({ summary }: { summary: KiloPassReferralRewardSummary }) {
  return (
    <section
      aria-labelledby="kilo-pass-referral-summary-heading"
      className="space-y-6 border-t border-border pt-6"
    >
      <div className="space-y-1.5">
        <h2 id="kilo-pass-referral-summary-heading" className="font-semibold tracking-tight">
          Reward summary
        </h2>
        <p className="text-sm text-muted-foreground">
          Track pending referral bonuses and previous Kilo Pass referral reward history.
        </p>
      </div>

      {summary.referrerCap.reached ? (
        <div className="flex flex-col gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium text-yellow-400">Cap reached</div>
            <div className="text-muted-foreground">
              {summary.referrerCap.grantedRewards} of {summary.referrerCap.limit} referrer rewards
              granted. Referee rewards do not count toward this cap.
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SummaryTile label="Total rewards" value={String(summary.totals.totalRewards)} />
        <SummaryTile
          label="Pending rewards"
          value={String(summary.totals.pendingRewards)}
          info="Pending rewards wait for a future eligible monthly Kilo Pass issuance."
          indicator={summary.totals.pendingRewards > 0 ? 'warning' : undefined}
        />
        <SummaryTile label="Applied rewards" value={String(summary.totals.appliedRewards)} />
        <SummaryTile
          label="Total bonus value"
          value={formatUsd(summary.totals.totalRewardAmountUsd)}
        />
        <SummaryTile
          label="Pending bonus value"
          value={formatUsd(summary.totals.pendingRewardAmountUsd)}
        />
        <SummaryTile
          label="Applied bonus value"
          value={formatUsd(summary.totals.appliedRewardAmountUsd)}
        />
      </div>

      <section aria-labelledby="kilo-pass-rewards-heading" className="space-y-3">
        <h3 id="kilo-pass-rewards-heading" className="text-sm font-semibold text-foreground">
          Reward history
        </h3>
        {summary.rewards.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No Kilo Pass referral rewards yet.{' '}
            <a
              href={`#${SHARE_WIDGET_ANCHOR_ID}`}
              className="rounded-sm text-foreground underline decoration-foreground/35 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Share your referral link
            </a>{' '}
            to earn a future monthly bonus.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {summary.rewards.map(reward => (
              <RewardRow key={reward.id} reward={reward} />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

type IndicatorTone = 'warning';

function SummaryTile({
  label,
  value,
  info,
  indicator,
}: {
  label: string;
  value: string;
  info?: string;
  indicator?: IndicatorTone;
}) {
  return (
    <div className="rounded-lg border border-border bg-input/30 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {indicator === 'warning' ? (
          <span
            className="size-1.5 rounded-full bg-yellow-500"
            aria-hidden="true"
            data-testid="summary-indicator-warning"
          />
        ) : null}
        <span>{label}</span>
        {info ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`More info: ${label}`}
                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{info}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function RewardRow({ reward }: { reward: KiloPassReferralRewardSummary['rewards'][number] }) {
  const status = rewardStatusPresentation(reward.status);
  return (
    <div className="grid gap-3 p-3 text-sm lg:grid-cols-[1.1fr_1.2fr_1.4fr] lg:items-start">
      <div className="space-y-1">
        <div className="font-medium text-foreground">{roleLabel(reward.role)}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3" aria-hidden="true" />
          <span>{formatTier(reward.sourceTier)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${status.className}`}
        >
          {status.label}
        </span>
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          ·
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatUsd(reward.rewardAmountUsd)}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <History className="size-3" aria-hidden="true" />
          <span>
            Earned{' '}
            <span className="font-mono tabular-nums">
              {formatIsoDateString_UsaDateOnlyFormat(reward.earnedAt)}
            </span>
          </span>
        </div>
        {reward.appliedAt ? (
          <div className="flex items-center gap-1.5">
            <CalendarDays className="size-3" aria-hidden="true" />
            <span>
              Applied{' '}
              <span className="font-mono tabular-nums">
                {formatIsoDateString_UsaDateOnlyFormat(reward.appliedAt)}
              </span>
            </span>
          </div>
        ) : reward.expiresAt ? (
          <div>
            Expires{' '}
            <span className="font-mono tabular-nums">
              {formatIsoDateString_UsaDateOnlyFormat(reward.expiresAt)}
            </span>
          </div>
        ) : reward.status === 'review_required' ? (
          <div>Support review required before this reward changes.</div>
        ) : (
          <div>Application details appear after the referral bonus is issued.</div>
        )}
      </div>
    </div>
  );
}
