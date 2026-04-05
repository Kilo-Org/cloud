import type { LucideIcon } from 'lucide-react';
import { CheckCircle, XCircle } from 'lucide-react';

export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'past_due'
  | 'unpaid';

export type StatusConfig = {
  variant: 'secondary-outline' | 'destructive' | 'secondary';
  icon: LucideIcon;
  color: string;
  borderColor: string;
};

const subscriptionStatusConfig: Record<SubscriptionStatus, StatusConfig> = {
  active: {
    variant: 'secondary-outline' as const,
    icon: CheckCircle,
    color: 'text-green-600',
    borderColor: 'border-l-green-600',
  },
  canceled: {
    variant: 'destructive' as const,
    icon: XCircle,
    color: 'text-white-600',
    borderColor: 'border-l-red-600',
  },
  incomplete: {
    variant: 'secondary' as const,
    icon: XCircle,
    color: 'text-yellow-600',
    borderColor: 'border-l-yellow-600',
  },
  incomplete_expired: {
    variant: 'secondary' as const,
    icon: XCircle,
    color: 'text-yellow-600',
    borderColor: 'border-l-yellow-600',
  },
  past_due: {
    variant: 'secondary' as const,
    icon: XCircle,
    color: 'text-red-600',
    borderColor: 'border-l-red-400',
  },
  unpaid: {
    variant: 'secondary' as const,
    icon: XCircle,
    color: 'text-red-600',
    borderColor: 'border-l-red-400',
  },
};

export function getSubscriptionStatusConfig(status: string): StatusConfig {
  return (
    subscriptionStatusConfig[status as SubscriptionStatus] || subscriptionStatusConfig.incomplete
  );
}

export function formatBillingInterval(interval: string | null | undefined): string {
  if (!interval) return 'N/A';

  switch (interval.toLowerCase()) {
    case 'day':
      return 'Daily';
    case 'week':
      return 'Weekly';
    case 'month':
      return 'Monthly';
    case 'year':
      return 'Yearly';
    default:
      return interval;
  }
}
