'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerBillingFailure } from '@kilocode/cloud-agent-sdk';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import type { BillingPayerPresentation } from './billing-payer-presentation';
import { setReturnUrlAndRedirect } from '@/components/shared/InsufficientBalanceBanner.actions';

type Props = {
  failure: CustomerBillingFailure;
  presentation: BillingPayerPresentation;
};

export function formatBillingMoney(value: number): string {
  return `$${(value / 1_000_000).toFixed(2)}`;
}

export function currentPaymentReturnPath(location: Pick<Location, 'pathname' | 'search'>): string {
  return `${location.pathname}${location.search}`;
}

export function billingBalanceCopy(failure: CustomerBillingFailure): string | null {
  const available =
    failure.remainingMicrodollars === undefined
      ? undefined
      : `Available: ${formatBillingMoney(failure.remainingMicrodollars)}`;
  const required =
    failure.minimumRequiredMicrodollars === undefined
      ? undefined
      : `Need more than ${formatBillingMoney(failure.minimumRequiredMicrodollars)}`;
  return [available, required].filter(Boolean).join(' · ') || null;
}

export function CloudAgentBillingError({ failure, presentation }: Props) {
  const router = useRouter();
  const [redirecting, setRedirecting] = useState(false);
  const { payerName, action } = presentation;
  const balanceCopy = billingBalanceCopy(failure);
  const content =
    failure.code === 'INSUFFICIENT_CREDITS'
      ? `${payerName} needs more credits to start Cloud Agent compute.`
      : failure.code === 'COMPUTE_STOPPING'
        ? 'Cloud Agent is saving and stopping compute. Your prompt has not started. Try again after shutdown completes.'
        : 'Cloud Agent cannot verify compute billing right now. Your prompt has not started and you have not been charged.';
  return (
    <Alert variant="destructive" className="min-w-0">
      <AlertCircle className="size-4" aria-hidden="true" />
      <AlertTitle>Compute billing</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{content}</p>
        {failure.code === 'INSUFFICIENT_CREDITS' && (
          <>
            {balanceCopy && <p className="font-mono text-xs tabular-nums">{balanceCopy}</p>}
            <p>Your prompt did not start.</p>
          </>
        )}
        {action && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={redirecting}
              onClick={async () => {
                if (redirecting) return;
                setRedirecting(true);
                await setReturnUrlAndRedirect(currentPaymentReturnPath(window.location)).catch(
                  () => undefined
                );
                router.push(action.href);
                setRedirecting(false);
              }}
            >
              {redirecting ? 'Redirecting…' : action.label}
            </Button>
            {action.memberGuidance && (
              <span className="text-muted-foreground text-xs">
                An organization owner, admin, or billing manager can add credits.
              </span>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
