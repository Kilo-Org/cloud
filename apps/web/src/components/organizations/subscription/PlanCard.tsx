'use client';

import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  OrganizationPlanSchema,
  type OrganizationPlan,
  type BillingCycle,
} from '@/lib/organizations/organization-types';

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

  return (
    <div
      onClick={onSelect}
      className={`relative w-84 rounded-lg border-2 p-6 transition-all ${
        isSelected
          ? 'border-blue-500 bg-blue-950/20'
          : 'border-gray-700 bg-gray-900 hover:border-gray-600'
      } ${!isSelected ? 'cursor-pointer opacity-50' : ''} ${className}`}
    >
      {/* Plan Badge */}
      {isCurrent && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-orange-600">
          CURRENT PLAN
        </Badge>
      )}
      {isUpgrade && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-green-600">UPGRADE</Badge>
      )}
      {isDowngrade && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gray-600">DOWNGRADE</Badge>
      )}

      {/* Plan Name */}
      <h3 className="mb-2 text-center text-xl font-semibold text-white">{planName}</h3>

      {/* Price */}
      <div className="mb-6 text-center">
        <div className="text-4xl font-bold text-white">
          ${pricePerMonth}
          <span className="text-lg font-normal text-gray-400">/user/month</span>
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {billingCycle === 'monthly' ? 'Billed monthly' : 'Billed annually'}
        </div>
      </div>

      {/* Features List */}
      <ul className="mb-6 space-y-3">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2 text-sm text-gray-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {/* Selection Indicator */}
      {isSelected && (
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-blue-400">
          <Check className="h-4 w-4" />
          Selected
        </div>
      )}
    </div>
  );
}
