'use client';

import { AlertCircle, AlertTriangle, ArrowRightLeft, Clock, CreditCard } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';
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

type BannerColorValue = 'blue' | 'amber' | 'red';

function getBannerColor(state: ClawBannerState): BannerColorValue | null {
  switch (state) {
    case 'trial_active':
    case 'subscription_converting':
      return 'blue';
    case 'trial_ending_soon':
    case 'earlybird_ending_soon':
    case 'subscription_canceling':
      return 'amber';
    case 'trial_ending_very_soon':
    case 'trial_expires_today':
    case 'subscription_past_due':
      return 'red';
    case 'earlybird_active':
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

  const color = getBannerColor(state);
  if (!color) return null;

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
    <Banner color={color}>
      <Banner.Icon>
        <Icon />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>{content.title}</Banner.Title>
        <Banner.Description>{content.message}</Banner.Description>
      </Banner.Content>
      {content.cta && (
        <Banner.Action>
          <Banner.Button onClick={handleCta}>{content.cta}</Banner.Button>
        </Banner.Action>
      )}
    </Banner>
  );
}
