'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { getKiloClawCheckoutSuccessPhase } from './checkout-success-state';

/**
 * Checkout success polling states:
 * 1. Waiting for subscription creation (Stripe webhook fires)
 * 2. Waiting for invoice settlement (`activationState` still pending)
 * 3. Fully activated — redirect to dashboard
 *
 * Per Subscription Checkout rule 10, the subscription is not fully
 * activated until invoice settlement converts it to hybrid state.
 */
export function KiloClawCheckoutSuccessClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useTRPC();
  const [timedOut, setTimedOut] = useState(false);
  const instanceId = searchParams.get('clawInstanceId');

  const detailQuery = useQuery({
    ...trpc.kiloclaw.getSubscriptionDetail.queryOptions(
      { instanceId: instanceId ?? '00000000-0000-4000-8000-000000000000' },
      {
        enabled: !!instanceId,
      }
    ),
    refetchInterval: timedOut ? false : 1_000,
  });
  const billingStatusQuery = useQuery({
    ...trpc.kiloclaw.getActivePersonalBillingStatus.queryOptions(undefined, {
      enabled: !instanceId,
    }),
    refetchInterval: timedOut ? false : 1_000,
  });

  const sub = instanceId ? detailQuery.data : billingStatusQuery.data?.subscription;
  const phase = getKiloClawCheckoutSuccessPhase({
    subscription: sub,
    timedOut,
  });

  useEffect(() => {
    if (phase !== 'activated') return;
    const timer = setTimeout(() => router.push('/claw'), 2_000);
    return () => clearTimeout(timer);
  }, [phase, router]);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        {phase === 'activated' ? (
          <>
            <CheckCircle2 className="text-brand-primary mx-auto mb-4 size-12" />
            <h1 className="mb-2 text-2xl font-bold">Subscription Active!</h1>
            <p className="text-muted-foreground">Redirecting to your dashboard...</p>
          </>
        ) : phase === 'timed_out_waiting_for_settlement' ? (
          <>
            <h1 className="mb-2 text-2xl font-bold">Taking longer than expected</h1>
            <p className="text-muted-foreground mb-4">
              Your payment was received. Hosting still activates after invoice settlement.
            </p>
            <button
              type="button"
              onClick={() => router.push('/claw')}
              className="bg-brand-primary text-primary-foreground rounded-lg px-6 py-2 font-medium"
            >
              Go to Dashboard
            </button>
          </>
        ) : phase === 'timed_out_waiting_for_subscription' ? (
          <>
            <h1 className="mb-2 text-2xl font-bold">Taking longer than expected</h1>
            <p className="text-muted-foreground mb-4">
              We&apos;re still waiting for your hosting subscription to appear. If this does not
              update, check your billing history or try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => router.push('/claw')}
              className="bg-brand-primary text-primary-foreground rounded-lg px-6 py-2 font-medium"
            >
              Go to Dashboard
            </button>
          </>
        ) : phase === 'waiting_for_settlement' ? (
          <>
            <Loader2 className="text-brand-primary mx-auto mb-4 size-12 animate-spin" />
            <h1 className="mb-2 text-2xl font-bold">Processing payment...</h1>
            <p className="text-muted-foreground">
              Invoice settlement is still finishing. Hosting activates right after that.
            </p>
          </>
        ) : (
          <>
            <Loader2 className="text-brand-primary mx-auto mb-4 size-12 animate-spin" />
            <h1 className="mb-2 text-2xl font-bold">Setting up your subscription...</h1>
            <p className="text-muted-foreground">This usually takes just a moment.</p>
          </>
        )}
      </div>
    </div>
  );
}
