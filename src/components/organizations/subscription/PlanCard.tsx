'use client';

import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  OrganizationPlanSchema,
  type OrganizationPlan,
  type BillingCycle,
} from '@/lib/organizations/organization-types';
import { cn } from '@/lib/utils';

type PlanCardProps = {
  plan: OrganizationPlan;
  pricePerMonth: number;
  features: string[];
  isSelected: boolean;
  currentPlan: OrganizationPlan;
  onSelect: () => void;
  billingCycle?: BillingCycle;
  className?: string;
};

export function PlanCard({
  plan,
  pricePerMonth,
  features,
  isSelected,
  currentPlan,
  onSelect,
  billingCycle,
  className = '',
}: PlanCardProps) {
  const planName = plan === 'teams' ? 'Teams' : 'Enterprise';

  const isCurrent = plan === currentPlan;
  const cardIndex = OrganizationPlanSchema.options.indexOf(plan);
  const currentIndex = OrganizationPlanSchema.options.indexOf(currentPlan);
  const isUpgrade = currentIndex < cardIndex;
  const isDowngrade = currentIndex > cardIndex;

  const badgeLabel = isCurrent
    ? 'Current plan'
    : isUpgrade
      ? 'Upgrade'
      : isDowngrade
        ? 'Downgrade'
        : null;

  const badgeClassName = isCurrent
    ? 'border border-amber-300/70 bg-amber-300 text-amber-950 shadow-sm'
    : isUpgrade
      ? 'bg-emerald-500 text-black'
      : 'bg-muted text-foreground';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative flex h-full w-full flex-col rounded-2xl border p-6 text-left transition-all',
        'hover:border-blue-400/70 hover:shadow-[0_0_0_1px_rgba(59,130,246,0.2)]',
        isSelected
          ? 'border-blue-500/70 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]'
          : 'border-border/70 bg-background',
        className
      )}
    >
      {badgeLabel ? (
        <Badge
          className={cn(
            'absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3',
            badgeClassName
          )}
        >
          {badgeLabel.toUpperCase()}
        </Badge>
      ) : null}

      <div className="flex h-full flex-col gap-6">
        <div className="space-y-4 text-center">
          <h3 className="text-xl font-semibold">{planName}</h3>

          <div>
            <div className="flex items-end justify-center gap-1">
              <span className="text-4xl font-bold">${pricePerMonth}</span>
              <span className="text-muted-foreground pb-1 text-base font-normal">/user/month</span>
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              {billingCycle === 'monthly' ? 'Billed monthly' : 'Billed annually'}
            </div>
          </div>
        </div>

        <ul className="space-y-3">
          {features.map(feature => (
            <li key={feature} className="text-muted-foreground flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <div
          className={cn(
            'mt-auto flex items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors',
            isSelected
              ? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
              : 'border-border/70 text-muted-foreground group-hover:border-blue-400/40 group-hover:text-foreground'
          )}
        >
          {isSelected ? <Check className="h-4 w-4" /> : null}
          {isSelected ? 'Selected' : 'Select plan'}
        </div>
      </div>
    </button>
  );
}
