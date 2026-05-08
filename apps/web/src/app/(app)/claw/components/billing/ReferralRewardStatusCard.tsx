import React from 'react';
import Link from 'next/link';
import { CalendarDays, Gift, Info, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBillingDate } from './billing-types';

const SHARE_WIDGET_ANCHOR_ID = 'referral-share';

type ReferralRewardStatus =
  | 'pending'
  | 'earned'
  | 'applied'
  | 'expired'
  | 'canceled'
  | 'reversed'
  | 'review_required';

type ReferralRewardSummary = {
  totals: {
    totalRewards: number;
    pendingRewards: number;
    totalAppliedMonths: number;
  };
  pendingRewardAction: {
    showStartReactivateCta: boolean;
    pendingRewardCount: number;
  };
  referredPeople: Array<{
    maskedEmail: string | null;
    state: 'reward_granted' | 'waiting_for_paid_conversion';
    rewardGranted: boolean;
  }>;
  rewards: Array<{
    role: 'referrer' | 'referee';
    status: ReferralRewardStatus;
    monthsGranted: number;
    earnedAt: string;
    appliedAt: string | null;
    expiresAt: string | null;
    reviewReason: string | null;
    application: {
      appliedAt: string;
      subscriptionId: string | null;
      previousRenewalBoundary: string;
      newRenewalBoundary: string;
    } | null;
  }>;
};

type ReferralRewardStatusCardProps = {
  summary: ReferralRewardSummary;
  shareWidget?: React.ReactNode;
};

type StatusPresentation = {
  label: string;
  className: string;
};

function rewardStatusPresentation(status: ReferralRewardStatus): StatusPresentation {
  switch (status) {
    case 'applied':
      return {
        label: 'Applied',
        className: 'bg-emerald-500/20 text-emerald-400 ring-emerald-500/20',
      };
    case 'earned':
      return {
        label: 'Waiting for renewal extension',
        className: 'bg-blue-500/20 text-blue-400 ring-blue-500/20',
      };
    case 'pending':
      return {
        label: 'Waiting for an eligible KiloClaw subscription',
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

function roleLabel(role: 'referrer' | 'referee'): string {
  return role === 'referrer' ? 'Referral you shared' : 'Referral you used';
}

function monthLabel(months: number): string {
  return `${months} ${months === 1 ? 'free month' : 'free months'}`;
}

export function ReferralRewardStatusCard({ summary, shareWidget }: ReferralRewardStatusCardProps) {
  const showReactivateCta = summary.pendingRewardAction.showStartReactivateCta;

  return (
    <Card className="w-full text-left">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="size-4" aria-hidden="true" />
          Earn a free month of KiloClaw hosting
        </CardTitle>
        <CardDescription>
          Share KiloClaw with someone else and when they sign up for a paid subscription, you both
          get 1 free month of KiloClaw hosting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {shareWidget ? <section id={SHARE_WIDGET_ANCHOR_ID}>{shareWidget}</section> : null}

        {showReactivateCta ? (
          <div className="bg-input/30 flex flex-col gap-3 rounded-lg border border-border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="text-foreground">
              You have {summary.pendingRewardAction.pendingRewardCount}{' '}
              {summary.pendingRewardAction.pendingRewardCount === 1 ? 'reward' : 'rewards'} on hold.
              Start or reactivate KiloClaw to apply{' '}
              {summary.pendingRewardAction.pendingRewardCount === 1 ? 'it' : 'them'}.
            </div>
            <Button size="sm" asChild>
              <Link href="/claw/subscription">Start or reactivate KiloClaw</Link>
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryTile label="Total rewards earned" value={String(summary.totals.totalRewards)} />
          <SummaryTile
            label="Rewards on hold"
            value={String(summary.totals.pendingRewards)}
            info="Rewards can only be applied to an active subscription."
            indicator={summary.totals.pendingRewards > 0 ? 'warning' : undefined}
          />
          <SummaryTile label="Rewards applied" value={String(summary.totals.totalAppliedMonths)} />
        </div>

        <section aria-labelledby="my-rewards-heading" className="space-y-3">
          <h3 id="my-rewards-heading" className="text-sm font-semibold text-foreground">
            Earned rewards
          </h3>

          {summary.rewards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No referral rewards yet.{' '}
              <a
                href={`#${SHARE_WIDGET_ANCHOR_ID}`}
                className="text-foreground underline decoration-foreground/35 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm"
              >
                Share your referral link
              </a>{' '}
              to earn a free month.
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {summary.rewards.map((reward, index) => (
                <RewardRow
                  key={`${reward.role}-${reward.status}-${reward.earnedAt}-${index}`}
                  reward={reward}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="referred-people-heading" className="space-y-3">
          <h3 id="referred-people-heading" className="text-sm font-semibold text-foreground">
            Your referees
          </h3>

          {summary.referredPeople.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No referred people yet.
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {summary.referredPeople.map((person, index) => (
                <div
                  key={`${person.maskedEmail ?? 'unknown'}-${person.state}-${index}`}
                  className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="font-medium text-foreground">
                      {person.maskedEmail ?? 'Unknown referee'}
                    </div>
                    <div className="text-xs text-muted-foreground">Masked referee identity</div>
                  </div>
                  <span
                    className={
                      person.rewardGranted
                        ? 'inline-flex w-fit rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/20'
                        : 'inline-flex w-fit rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400 ring-1 ring-blue-500/20'
                    }
                  >
                    {person.state === 'reward_granted'
                      ? 'Reward granted'
                      : 'Signed up, waiting for paid KiloClaw conversion'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
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
    <div className="bg-input/30 rounded-lg border border-border px-3 py-2.5">
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
                className="text-muted-foreground hover:text-foreground focus-visible:text-foreground rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{info}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums leading-none text-foreground">
        {value}
      </div>
    </div>
  );
}

function RewardRow({ reward }: { reward: ReferralRewardSummary['rewards'][number] }) {
  const status = rewardStatusPresentation(reward.status);
  return (
    <div className="grid gap-3 p-3 text-sm lg:grid-cols-[1.1fr_1.2fr_1.4fr] lg:items-start">
      <div className="space-y-1">
        <div className="font-medium text-foreground">{roleLabel(reward.role)}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3" aria-hidden="true" />
          <span>
            Earned{' '}
            <span className="font-mono tabular-nums">{formatBillingDate(reward.earnedAt)}</span>
          </span>
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
        <span className="text-xs text-muted-foreground">{monthLabel(reward.monthsGranted)}</span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {reward.application ? (
          <>
            <div className="flex items-center gap-1.5">
              <CalendarDays className="size-3" aria-hidden="true" />
              <span>
                Applied{' '}
                <span className="font-mono tabular-nums">
                  {formatBillingDate(reward.application.appliedAt)}
                </span>
              </span>
            </div>
            <div>
              Renewal moved{' '}
              <span className="font-mono tabular-nums">
                {formatBillingDate(reward.application.previousRenewalBoundary)}
              </span>{' '}
              to{' '}
              <span className="font-mono tabular-nums">
                {formatBillingDate(reward.application.newRenewalBoundary)}
              </span>
            </div>
          </>
        ) : reward.expiresAt ? (
          <div>
            Expires{' '}
            <span className="font-mono tabular-nums">{formatBillingDate(reward.expiresAt)}</span>
          </div>
        ) : (
          <div>Reward application details appear after the free month is applied.</div>
        )}
      </div>
    </div>
  );
}
