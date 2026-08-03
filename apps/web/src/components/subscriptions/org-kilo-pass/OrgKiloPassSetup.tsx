'use client';

import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/constants';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { formatDateLabel } from '../helpers';
import { formatOrgPassMoney } from './formatters';
import { toSetupAllocations, toSetupTerms } from './mappers';
import { OrgKiloPassSetupView } from './OrgKiloPassSetupView';
import {
  childAllocationInput,
  loadOrgKiloPassSelection,
  saveOrgKiloPassSelection,
} from './selection';
import type { OrgKiloPassAllocation, OrgKiloPassTerms, OrgKiloPassTier } from './types';

let stripePromise: Promise<Stripe | null> | null = null;

function getStripe() {
  if (!stripePromise && STRIPE_PUBLISHABLE_KEY) stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);
  return stripePromise;
}

function quote(
  terms: OrgKiloPassTerms[],
  tier: OrgKiloPassTier,
  seats: number,
  cadence: 'monthly' | 'yearly'
) {
  const selected = terms.find(option => option.tier === tier) ?? terms[0];
  const amount = (selected?.pricePerPassUsd ?? 0) * seats;
  const recurring = cadence === 'yearly' ? amount * 12 : amount;
  return {
    recurringTotal: `${formatOrgPassMoney(recurring)}/${cadence === 'yearly' ? 'year' : 'month'}`,
    firstCharge: formatOrgPassMoney(recurring),
  };
}

export function OrgKiloPassSetup({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const router = useRouter();
  const setupQuery = useQuery(trpc.organizations.kiloPass.setup.queryOptions({ organizationId }));
  const checkout = useMutation(
    trpc.organizations.kiloPass.createCheckout.mutationOptions({
      onSuccess: async result => {
        if (result.kind === 'payment_action') {
          const stripe = await getStripe();
          if (!stripe) throw new Error('Payment system unavailable. Please try again later.');
          const { error, paymentIntent } = await stripe.handleNextAction({
            clientSecret: result.clientSecret,
          });
          if (error)
            throw new Error(error.message || 'Payment authentication failed. Please try again.');
          if (paymentIntent?.status !== 'succeeded') {
            toast.message(
              'Payment authentication is still pending. Complete it in Stripe to continue.'
            );
          } else {
            try {
              await trpcClient.organizations.kiloPass.reconcilePayment.mutate({ organizationId });
            } catch {
              // The detail page retries reconciliation and the Stripe webhook remains authoritative.
            }
          }
        }
        router.replace(`/organizations/${organizationId}/subscriptions/kilo-pass`);
      },
      onError: error => toast.error(error.message || 'Could not start checkout.'),
    })
  );
  const savedSelection =
    typeof window === 'undefined' ? null : loadOrgKiloPassSelection(organizationId);
  const [tier, setTier] = useState<OrgKiloPassTier>(savedSelection?.tier ?? 'tier_19');
  const [allocations, setAllocations] = useState<OrgKiloPassAllocation[] | null>(
    savedSelection?.allocations ?? null
  );
  const setup = setupQuery.data;

  if (setupQuery.isError)
    return <OrgKiloPassSetupError onRetry={() => void setupQuery.refetch()} />;
  if (setupQuery.isPending || !setup) return <OrgKiloPassSetupLoading />;

  const terms = toSetupTerms(setup);
  const currentAllocations =
    allocations ?? toSetupAllocations(organizationId, organizationName, setup.children);
  const onChildAllocationChange = (childOrganizationId: string, passCount: number) => {
    setAllocations(current =>
      (current ?? toSetupAllocations(organizationId, organizationName, setup.children)).map(
        allocation =>
          allocation.organizationId === childOrganizationId
            ? { ...allocation, passCount }
            : allocation
      )
    );
  };
  const onContinueToStripe = () => {
    saveOrgKiloPassSelection(organizationId, { tier, allocations: currentAllocations });
    checkout.mutate({
      organizationId,
      tier,
      allocations: childAllocationInput(currentAllocations),
    });
  };

  return (
    <OrgKiloPassSetupView
      organizationId={organizationId}
      organizationName={organizationName}
      paidSeats={setup.paidSeatCount}
      cadence={setup.cadence === 'yearly' ? 'annual' : 'monthly'}
      renewalDate={formatDateLabel(setup.renewalAt)}
      selectedTier={tier}
      terms={terms}
      allocations={currentAllocations}
      quote={quote(terms, tier, setup.paidSeatCount, setup.cadence)}
      isSubmitting={checkout.isPending}
      onTierChange={setTier}
      onChildAllocationChange={onChildAllocationChange}
      onContinueToStripe={onContinueToStripe}
    />
  );
}

function OrgKiloPassSetupLoading() {
  return (
    <p className="p-6 type-body text-muted-foreground" aria-busy="true">
      Loading Kilo Pass setup…
    </p>
  );
}

function OrgKiloPassSetupError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-3 p-6">
      <p className="type-body">Kilo Pass setup could not be loaded.</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
