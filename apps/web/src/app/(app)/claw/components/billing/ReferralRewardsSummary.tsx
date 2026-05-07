import React from 'react';
import Link from 'next/link';
import { ArrowRight, CalendarDays, Gift } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ClawBillingStatus } from './billing-types';
import { formatBillingDate } from './billing-types';

type ReferralRewards = NonNullable<ClawBillingStatus['subscription']>['referralRewards'];

type ReferralRewardsSummaryProps = {
  rewards: ReferralRewards;
  /**
   * `card` (default) renders inside its own bordered container. Use this when
   * the summary stands alone as a sibling card on a detail page.
   * `section` renders as a flat block separated by a top divider — use it when
   * embedding inside another `<Card>` to avoid the nested-card anti-pattern.
   */
  variant?: 'card' | 'section';
};

function roleLabel(role: ReferralRewards['applications'][number]['role']): string {
  // Address the user, not the system. "Referee" is internal jargon.
  return role === 'referrer' ? 'Reward for referring' : 'Welcome reward';
}

function monthsLabel(months: number): string {
  return `${months} ${months === 1 ? 'free month' : 'free months'}`;
}

export function ReferralRewardsSummary({ rewards, variant = 'card' }: ReferralRewardsSummaryProps) {
  const isCard = variant === 'card';

  return (
    <section
      aria-labelledby="referral-rewards-heading"
      aria-live="polite"
      className={cn(
        isCard ? 'rounded-lg border border-border bg-background/40 p-4' : 'pt-5',
        !isCard && 'border-t border-border'
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
            <Gift className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h3 id="referral-rewards-heading" className="text-foreground text-sm font-semibold">
              Referral rewards
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Free months push your renewal date out.
            </p>
          </div>
        </div>
        {rewards.totalAppliedMonths > 0 ? (
          <Badge variant="new" className="tabular-nums">
            {monthsLabel(rewards.totalAppliedMonths)} applied
          </Badge>
        ) : null}
      </div>

      {rewards.applications.length === 0 ? (
        <div className="border-border text-muted-foreground mt-4 flex flex-col gap-3 rounded-md border border-dashed px-3 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>No rewards yet. Refer a friend to earn a free month.</p>
          <Button size="sm" asChild>
            <Link href="/claw/refer">Refer a friend</Link>
          </Button>
        </div>
      ) : (
        <ul className="border-border divide-border divide-y mt-4 list-none rounded-md border">
          {rewards.applications.map(application => (
            <li
              key={`${application.role}-${application.appliedAt}-${application.newRenewalBoundary}`}
              className="space-y-2 px-3 py-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="text-foreground font-medium">{roleLabel(application.role)}</div>
                <div className="text-muted-foreground tabular-nums">
                  {monthsLabel(application.monthsGranted)}
                </div>
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="size-3" aria-hidden="true" />
                  <span className="tabular-nums">
                    Applied {formatBillingDate(application.appliedAt)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span>Renewal:</span>
                  <span className="text-foreground tabular-nums">
                    {formatBillingDate(application.previousRenewalBoundary)}
                  </span>
                  <ArrowRight className="size-3" aria-hidden="true" />
                  <span className="text-foreground tabular-nums">
                    {formatBillingDate(application.newRenewalBoundary)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
