'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock, CreditCard, Trash2, Coins } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ClawBillingStatus, ClawLockReason } from './billing-types';

type AccessLockedDialogProps = {
  reason: ClawLockReason;
  billing: ClawBillingStatus;
  onSubscribeClick: () => void;
  onUpdatePaymentClick: () => void;
  onDestroyClick: () => void;
  isDestroying?: boolean;
};

function getLockContent(reason: ClawLockReason, billing: ClawBillingStatus) {
  const isCreditFunded =
    billing.subscription &&
    !billing.subscription.hasStripeFunding &&
    billing.subscription.paymentSource === 'credits';

  switch (reason) {
    case 'trial_expired_instance_alive':
      return {
        title: 'Your Trial Has Ended',
        description: 'Your KiloClaw has been stopped. Subscribe to resume.',
        cta: 'Subscribe to Resume',
        action: 'subscribe' as const,
        icon: Lock,
      };
    case 'trial_expired_instance_destroyed':
      return {
        title: 'Your Trial Has Ended',
        description: 'Your KiloClaw has been destroyed. Subscribe to start fresh with a new one.',
        cta: 'Subscribe',
        action: 'subscribe' as const,
        icon: Lock,
      };
    case 'earlybird_expired':
      return {
        title: 'Earlybird Hosting Expired',
        description:
          'Your earlybird hosting period has ended. Subscribe to continue using KiloClaw.',
        cta: 'Subscribe to Continue',
        action: 'subscribe' as const,
        icon: Lock,
      };
    case 'subscription_expired_instance_alive':
      return {
        title: 'Subscription Ended',
        description: 'Your KiloClaw has been stopped. Subscribe to resume.',
        cta: 'Subscribe to Resume',
        action: 'subscribe' as const,
        icon: Lock,
      };
    case 'subscription_expired_instance_destroyed':
      return {
        title: 'Subscription Ended',
        description: 'Your KiloClaw has been destroyed. Subscribe to provision a new one.',
        cta: 'Subscribe',
        action: 'subscribe' as const,
        icon: Lock,
      };
    case 'past_due_grace_exceeded':
      if (isCreditFunded) {
        const balance = billing.creditBalanceMicrodollars ?? 0;
        const renewalCost = billing.subscription?.renewalCostMicrodollars ?? Infinity;
        const canAffordRenewal = balance >= renewalCost;
        return {
          title: 'Insufficient Credits',
          description:
            'Your subscription is suspended because your credit balance was insufficient for renewal.',
          cta: canAffordRenewal ? 'Reactivate with Credits' : 'Add Credits',
          action: (canAffordRenewal ? 'subscribe' : 'add_credits') as
            | 'subscribe'
            | 'add_credits'
            | 'update_payment',
          icon: Coins,
        };
      }
      return {
        title: 'Payment Issue',
        description:
          'Your subscription is suspended due to a payment failure. Update your payment method to continue.',
        cta: 'Update Payment Method',
        action: 'update_payment' as const,
        icon: CreditCard,
      };
    case 'no_access':
      return {
        title: 'Subscription Required',
        description:
          'A KiloClaw subscription is required to continue. Subscribe to keep your instance running.',
        cta: 'Subscribe',
        action: 'subscribe' as const,
        icon: Lock,
      };
    default:
      return null;
  }
}

function getInfoBoxMessage(reason: ClawLockReason, billing: ClawBillingStatus): string {
  if (
    reason === 'trial_expired_instance_destroyed' ||
    reason === 'subscription_expired_instance_destroyed'
  ) {
    return "You'll need to provision a new KiloClaw after subscribing.";
  }
  if (reason === 'past_due_grace_exceeded') {
    const isCreditFunded =
      billing.subscription &&
      !billing.subscription.hasStripeFunding &&
      billing.subscription.paymentSource === 'credits';
    if (isCreditFunded) {
      return 'Your KiloClaw will resume automatically once your credit balance is sufficient.';
    }
    return 'Your KiloClaw will resume automatically once payment is resolved.';
  }
  if (reason === 'no_access') {
    return 'Subscribe to unlock full access to KiloClaw.';
  }
  return 'Your KiloClaw will resume automatically once you subscribe.';
}

const INSTANCE_ALIVE_REASONS = new Set<ClawLockReason>([
  'trial_expired_instance_alive',
  'subscription_expired_instance_alive',
]);

export function AccessLockedDialog({
  reason,
  billing,
  onSubscribeClick,
  onUpdatePaymentClick,
  onDestroyClick,
  isDestroying,
}: AccessLockedDialogProps) {
  const router = useRouter();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  if (!reason) return null;

  const content = getLockContent(reason, billing);
  if (!content) return null;

  const Icon = content.icon;
  const canDestroy = INSTANCE_ALIVE_REASONS.has(reason);

  function handleCta() {
    if (content?.action === 'update_payment') {
      onUpdatePaymentClick();
    } else if (content?.action === 'add_credits') {
      router.push('/credits');
    } else {
      onSubscribeClick();
    }
  }

  function handleDismiss() {
    router.push('/');
  }

  const isCreditFunded =
    billing.subscription &&
    !billing.subscription.hasStripeFunding &&
    billing.subscription.paymentSource === 'credits';

  return (
    <Dialog open={true} onOpenChange={() => handleDismiss()} modal={true}>
      <DialogContent showCloseButton={true} className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-red-500/15">
            <div className="relative">
              <Icon className="h-8 w-8 text-red-400" />
              <div className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-red-500/30 bg-red-500/60" />
            </div>
          </div>
          <DialogTitle className="text-center text-2xl font-bold text-red-400">
            {content.title}
          </DialogTitle>
          <DialogDescription className="text-center text-base">
            {content.description}
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-muted-foreground text-center text-sm">
            {getInfoBoxMessage(reason, billing)}
          </p>
        </div>

        <DialogFooter className="flex-col gap-3 sm:flex-col">
          <Button onClick={handleCta} variant="primary" className="w-full py-3 font-semibold">
            {content.cta}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            {content.action === 'add_credits'
              ? "You'll be redirected to the credits page to top up your balance"
              : reason === 'past_due_grace_exceeded' && !isCreditFunded
                ? "You'll be redirected to Stripe to update your payment method"
                : "You'll be redirected to complete your purchase"}
          </p>

          {/* Secondary CTA: for credit-funded past-due, offer Kilo Pass as primary upgrade path */}
          {reason === 'past_due_grace_exceeded' && isCreditFunded && (
            <Button variant="outline" className="w-full" asChild>
              <Link href="/kilo-pass">Get Kilo Pass for Auto-Funding</Link>
            </Button>
          )}

          {canDestroy &&
            (confirmDestroy ? (
              <div className="flex w-full gap-2">
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={isDestroying}
                  onClick={onDestroyClick}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  {isDestroying ? 'Destroying...' : 'Yes, destroy'}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={isDestroying}
                  onClick={() => setConfirmDestroy(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="link"
                onClick={() => setConfirmDestroy(true)}
                className="text-muted-foreground hover:text-destructive w-full"
              >
                Destroy Instance
              </Button>
            ))}

          <Button
            variant="link"
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground w-full"
          >
            Go to Dashboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
