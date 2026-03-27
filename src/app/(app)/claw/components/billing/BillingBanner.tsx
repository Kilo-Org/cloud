'use client';

import { AlertCircle, AlertTriangle, ArrowRightLeft, Clock, CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ClawBannerState, ClawBillingStatus } from './billing-types';
import { deriveBannerState, formatBillingDate } from './billing-types';

function pluralizeDays(n: number | undefined): string {
  return n === 1 ? '1 day' : `${n} days`;
}

type BillingBannerProps = {
  billing: ClawBillingStatus;
  onSubscribeClick: () => void;
  onReactivateClick: () => void;
  onUpdatePaymentClick: () => void;
};

function getBannerStyles(state: ClawBannerState) {
  switch (state) {
    case 'trial_active':
      return {
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/30',
        text: 'text-blue-400',
        icon: 'text-blue-400',
      };
    case 'subscription_converting':
      return {
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/30',
        text: 'text-blue-400',
        icon: 'text-blue-400',
      };
    case 'trial_ending_soon':
    case 'earlybird_ending_soon':
    case 'subscription_canceling':
      return {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        text: 'text-amber-400',
        icon: 'text-amber-400',
      };
    case 'trial_ending_very_soon':
    case 'trial_expires_today':
    case 'subscription_past_due':
      return {
        bg: 'bg-red-500/10',
        border: 'border-red-500/30',
        text: 'text-red-400',
        icon: 'text-red-400',
      };
    case 'earlybird_active':
      // No top banner for active earlybird — handled by SubscriptionCard
      return null;
    default:
      return null;
  }
}

function getBannerIcon(state: ClawBannerState) {
  switch (state) {
    case 'trial_active':
    case 'earlybird_active':
      return Clock;
    case 'subscription_converting':
      return ArrowRightLeft;
    case 'trial_ending_soon':
    case 'earlybird_ending_soon':
    case 'subscription_canceling':
      return AlertCircle;
    case 'subscription_past_due':
      return CreditCard;
    default:
      return AlertTriangle;
  }
}

function getBannerContent(state: ClawBannerState, billing: ClawBillingStatus) {
  switch (state) {
    case 'trial_active':
      return {
        title: `Free Trial — ${pluralizeDays(billing.trial?.daysRemaining)} remaining`,
        message: `Your trial expires on ${formatBillingDate(billing.trial?.endsAt ?? '')}.`,
        cta: 'Subscribe Now',
        action: 'subscribe' as const,
      };
    case 'trial_ending_soon':
      return {
        title: `Free Trial Ending Soon — ${pluralizeDays(billing.trial?.daysRemaining)} left`,
        message: `Your trial expires on ${formatBillingDate(billing.trial?.endsAt ?? '')}. Subscribe now to avoid interruption.`,
        cta: 'Subscribe Now',
        action: 'subscribe' as const,
      };
    case 'trial_ending_very_soon':
      return {
        title: `Free Trial Ending Very Soon — ${pluralizeDays(billing.trial?.daysRemaining)} left`,
        message: 'Your KiloClaw will be stopped when the trial ends. Subscribe to keep it running.',
        cta: 'Subscribe Now',
        action: 'subscribe' as const,
      };
    case 'trial_expires_today':
      return {
        title: 'Free Trial Ends Today',
        message: 'Your KiloClaw will be stopped at the end of today. Subscribe now.',
        cta: 'Subscribe Now',
        action: 'subscribe' as const,
      };
    case 'earlybird_active':
      return {
        title: `Earlybird Hosting — Expires ${formatBillingDate(billing.earlybird?.expiresAt ?? '')}`,
        message: 'Thanks for being an early KiloClaw subscriber.',
        cta: null,
        action: null,
      };
    case 'earlybird_ending_soon':
      return {
        title: `Earlybird Hosting Expiring Soon — ${pluralizeDays(billing.earlybird?.daysRemaining)} left`,
        message: `Your earlybird hosting expires on ${formatBillingDate(billing.earlybird?.expiresAt ?? '')}. Subscribe to continue.`,
        cta: 'Subscribe',
        action: 'subscribe' as const,
      };
    case 'subscription_converting':
      return {
        title: `Switching to credit billing on ${formatBillingDate(billing.subscription?.currentPeriodEnd ?? '')}`,
        message:
          'Your Stripe charge ends at the current period. After that, hosting renews from your credit balance.',
        cta: null,
        action: null,
      };
    case 'subscription_canceling':
      return {
        title: `Your plan ends on ${formatBillingDate(billing.subscription?.currentPeriodEnd ?? '')}`,
        message:
          'After this date your instance will be stopped. You can reactivate anytime before then.',
        cta: 'Reactivate',
        action: 'reactivate' as const,
      };
    case 'subscription_past_due':
      return {
        title: 'Payment failed — action required',
        message:
          'Your subscription payment failed. Update your payment method to keep your instance running.',
        cta: 'Update Payment',
        action: 'update_payment' as const,
      };
    default:
      return null;
  }
}

export function BillingBanner({
  billing,
  onSubscribeClick,
  onReactivateClick,
  onUpdatePaymentClick,
}: BillingBannerProps) {
  const state = deriveBannerState(billing);

  if (state === 'subscribed' || state === 'none') return null;

  const styles = getBannerStyles(state);
  if (!styles) return null;

  const content = getBannerContent(state, billing);
  if (!content) return null;

  const Icon = getBannerIcon(state);

  function handleCta() {
    switch (content?.action) {
      case 'subscribe':
        onSubscribeClick();
        break;
      case 'reactivate':
        onReactivateClick();
        break;
      case 'update_payment':
        onUpdatePaymentClick();
        break;
    }
  }

  return (
    <div
      className={cn(
        'flex w-full items-center gap-4 rounded-xl border p-4',
        styles.bg,
        styles.border,
        styles.text
      )}
    >
      <div className={cn('flex shrink-0 items-center', styles.icon)}>
        <Icon className="h-6 w-6" />
      </div>

      <div className="flex-1">
        <div className="mb-0.5 text-sm font-bold">{content.title}</div>
        <p className="text-muted-foreground text-sm">{content.message}</p>
      </div>

      {content.cta && (
        <Button onClick={handleCta} variant="primary" className="shrink-0">
          {content.cta}
        </Button>
      )}
    </div>
  );
}
