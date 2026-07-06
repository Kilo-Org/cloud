'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Code2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatCodingPlanPrice,
  formatDateLabel,
  formatLocalDateTimeLabel,
  getCodingPlanBillingDate,
  getCodingPlanDisplayStatus,
  getCodingPlanPriceParts,
  isCodingPlanTerminal,
} from '@/components/subscriptions/helpers';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { MiniMaxPlanIcon } from './MiniMaxPlanIcon';

export function CodingPlansGroup({
  showTerminal = false,
  accordionValue,
  hideHeader = false,
}: {
  showTerminal?: boolean;
  accordionValue?: string;
  hideHeader?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const subscriptionQuery = useQuery(trpc.codingPlans.listSubscriptions.queryOptions());
  const catalogQuery = useQuery(trpc.codingPlans.catalog.queryOptions());
  const byokQuery = useQuery(trpc.byok.list.queryOptions({}));
  const [subscriptionRequest, setSubscriptionRequest] = useState<{
    planId: string;
    idempotencyKey: string;
  } | null>(null);

  const subscriptions = subscriptionQuery.data ?? [];
  const catalog = catalogQuery.data ?? [];
  const minimaxKeys = byokQuery.data?.filter(key => key.provider_id === 'minimax') ?? [];
  const hasManagedMiniMaxKey = minimaxKeys.some(key => key.management_source === 'coding_plan');
  const hasUserManagedMiniMaxKey = minimaxKeys.some(key => key.management_source !== 'coding_plan');
  const hasMiniMaxKey = minimaxKeys.length > 0;
  const selectedPlan = catalog.find(plan => plan.planId === subscriptionRequest?.planId) ?? null;
  const nonTerminalSubscriptions = subscriptions.filter(
    subscription => !isCodingPlanTerminal(subscription.status)
  );
  const liveProviderIds = new Set(
    nonTerminalSubscriptions.map(subscription => subscription.providerId)
  );
  const hasLiveMiniMaxSubscription = liveProviderIds.has('minimax');
  const visibleSubscriptions = subscriptions.filter(
    subscription => !isCodingPlanTerminal(subscription.status) || showTerminal
  );

  const subscribeMutation = useMutation(
    trpc.codingPlans.subscribe.mutationOptions({
      onSuccess: async () => {
        toast.success('Coding Plan subscription activated');
        setSubscriptionRequest(null);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.codingPlans.listSubscriptions.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.byok.list.queryKey({}),
          }),
        ]);
      },
      onError: async error => {
        if (error.message.includes('No managed credential')) {
          await queryClient.invalidateQueries({ queryKey: trpc.codingPlans.catalog.queryKey() });
          toast.error('This Coding Plan is currently sold out.');
          return;
        }
        toast.error(error.message || 'Unable to activate Coding Plan subscription');
      },
    })
  );
  const notificationMutation = useMutation(
    trpc.codingPlans.requestAvailabilityNotification.mutationOptions({
      onSuccess: async () => {
        toast.success('We will notify you when this Coding Plan is available.');
        await queryClient.invalidateQueries({ queryKey: trpc.codingPlans.catalog.queryKey() });
      },
      onError: async error => {
        if (error.message.includes('currently available')) {
          await queryClient.invalidateQueries({ queryKey: trpc.codingPlans.catalog.queryKey() });
          toast.info('This Coding Plan is available now.');
          return;
        }
        toast.error(error.message || 'Unable to save notification request.');
      },
    })
  );

  function openSubscribeDialog(plan: CodingPlanOffer) {
    if (liveProviderIds.has(plan.providerId) || (plan.providerId === 'minimax' && hasMiniMaxKey)) {
      return;
    }
    setSubscriptionRequest({ planId: plan.planId, idempotencyKey: crypto.randomUUID() });
  }

  function closeSubscribeDialog() {
    if (!subscribeMutation.isPending) {
      setSubscriptionRequest(null);
    }
  }

  function confirmSubscription() {
    if (
      !selectedPlan ||
      !subscriptionRequest ||
      liveProviderIds.has(selectedPlan.providerId) ||
      (selectedPlan.providerId === 'minimax' && hasMiniMaxKey) ||
      subscribeMutation.isPending
    ) {
      return;
    }

    subscribeMutation.mutate({
      planId: selectedPlan.planId,
      idempotencyKey: subscriptionRequest.idempotencyKey,
    });
  }

  const isLoading = subscriptionQuery.isLoading || catalogQuery.isLoading || byokQuery.isLoading;
  const isError = subscriptionQuery.isError || catalogQuery.isError || byokQuery.isError;
  const error = subscriptionQuery.error ?? catalogQuery.error ?? byokQuery.error ?? null;

  return (
    <SubscriptionGroup
      title="Coding Plans"
      description="Manage provider plan access paid with Kilo Credits."
      headerIcon={<Code2 className="size-5" />}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() =>
        void Promise.all([subscriptionQuery.refetch(), catalogQuery.refetch(), byokQuery.refetch()])
      }
      accordionValue={accordionValue}
      hideHeader={hideHeader}
      unframed={hideHeader}
    >
      <div className="space-y-5">
        {visibleSubscriptions.length > 0 ? (
          <div className="grid gap-3">
            {visibleSubscriptions.map(subscription => {
              const status = getCodingPlanDisplayStatus(subscription);
              const billingDate = getCodingPlanBillingDate(subscription);
              const formattedBillingDate =
                status === 'past_due'
                  ? formatLocalDateTimeLabel(billingDate.date)
                  : formatDateLabel(billingDate.date);
              const needsAttention = status === 'past_due' || status === 'pending_cancellation';
              const statusNote =
                status === 'past_due'
                  ? `Payment recovery required before ${formattedBillingDate}.`
                  : status === 'pending_cancellation'
                    ? `Access remains active through ${formattedBillingDate}.`
                    : null;

              return (
                <SubscriptionCard
                  key={subscription.id}
                  icon={<CodingPlanIcon providerName={subscription.providerName} />}
                  title={`${subscription.providerName} ${subscription.planName}`}
                  status={status}
                  price={formatCodingPlanPrice(
                    subscription.costKiloCredits,
                    subscription.billingPeriodDays,
                    subscription.planId
                  )}
                  billingDateLabel={billingDate.label}
                  billingDate={formattedBillingDate}
                  paymentMethod="Credits"
                  href={`/subscriptions/coding-plans/${subscription.id}`}
                  isTerminal={isCodingPlanTerminal(subscription.status)}
                  statusNote={statusNote}
                  warningTone={needsAttention ? 'warning' : undefined}
                />
              );
            })}
          </div>
        ) : null}

        <div className="space-y-4">
          {catalog.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Coding Plans are currently available.
            </p>
          ) : (
            <div className="space-y-4">
              {hasLiveMiniMaxSubscription || hasMiniMaxKey ? (
                <MiniMaxAccessNotice
                  hasLiveSubscription={hasLiveMiniMaxSubscription}
                  hasManagedKey={hasManagedMiniMaxKey}
                  hasUserManagedKey={hasUserManagedMiniMaxKey}
                />
              ) : null}
              <div
                className={cn(
                  'grid gap-4',
                  catalog.length === 2 && 'lg:grid-cols-2',
                  catalog.length >= 3 && 'lg:grid-cols-3'
                )}
              >
                {catalog.map(plan => (
                  <CodingPlanOfferCard
                    key={plan.planId}
                    plan={plan}
                    compact={catalog.length > 1}
                    hasBlockingMiniMaxKey={plan.providerId === 'minimax' && hasMiniMaxKey}
                    hasLiveProviderSubscription={liveProviderIds.has(plan.providerId)}
                    notificationPending={
                      notificationMutation.isPending &&
                      notificationMutation.variables?.planId === plan.planId
                    }
                    notificationSaving={notificationMutation.isPending}
                    onSubscribe={() => openSubscribeDialog(plan)}
                    onRequestNotification={() =>
                      notificationMutation.mutate({ planId: plan.planId })
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={selectedPlan !== null}
        onOpenChange={open => !open && closeSubscribeDialog()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Subscribe to{' '}
              {selectedPlan ? `${selectedPlan.providerName} ${selectedPlan.name}` : 'this plan'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedPlan
                ? `You will pay ${formatCodingPlanPrice(selectedPlan.costKiloCredits, selectedPlan.billingPeriodDays, selectedPlan.planId)} from your Kilo Credits balance. Kilo automatically configures MiniMax in your BYOK settings.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={subscribeMutation.isPending}>
              Keep browsing
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 focus-visible:ring-brand-primary/50"
              onClick={event => {
                event.preventDefault();
                confirmSubscription();
              }}
              disabled={subscribeMutation.isPending}
              aria-busy={subscribeMutation.isPending}
            >
              {subscribeMutation.isPending ? 'Subscribing...' : 'Subscribe with Kilo Credits'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SubscriptionGroup>
  );
}

type CodingPlanOffer = {
  planId: string;
  providerId: string;
  providerName: string;
  name: string;
  costKiloCredits: number;
  billingPeriodDays: number;
  features: readonly string[];
  availabilityStatus: 'available' | 'sold_out';
  notificationRequested: boolean;
};

function MiniMaxAccessNotice({
  hasLiveSubscription,
  hasManagedKey,
  hasUserManagedKey,
}: {
  hasLiveSubscription: boolean;
  hasManagedKey: boolean;
  hasUserManagedKey: boolean;
}) {
  let description = (
    <span>MiniMax Coding Plans are unavailable while this BYOK key is active.</span>
  );
  if (hasLiveSubscription) {
    description = (
      <span>
        Keep your current Coding Plan, or cancel it and wait for access to end before switching
        tiers. Kilo removes its managed MiniMax BYOK key automatically when plan access ends.
      </span>
    );
  } else if (hasManagedKey) {
    description = (
      <span>
        Your previous Coding Plan is finishing cleanup. Kilo removes its managed MiniMax BYOK key
        automatically; try subscribing again after cleanup completes.
      </span>
    );
  } else if (hasUserManagedKey) {
    description = (
      <span>
        Remove your existing MiniMax key in{' '}
        <Link href="/byok" className="text-foreground underline underline-offset-4">
          BYOK settings
        </Link>{' '}
        before subscribing to a MiniMax Coding Plan.
      </span>
    );
  }

  return (
    <div className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 text-sm">
      <p className="text-foreground font-medium">MiniMax access is already active.</p>
      <p className="mt-1">{description}</p>
    </div>
  );
}

function CodingPlanOfferCard({
  plan,
  hasBlockingMiniMaxKey,
  hasLiveProviderSubscription,
  notificationPending,
  notificationSaving,
  compact,
  onSubscribe,
  onRequestNotification,
}: {
  plan: CodingPlanOffer;
  hasBlockingMiniMaxKey: boolean;
  hasLiveProviderSubscription: boolean;
  notificationPending: boolean;
  notificationSaving: boolean;
  compact: boolean;
  onSubscribe: () => void;
  onRequestNotification: () => void;
}) {
  const isSoldOut = plan.availabilityStatus === 'sold_out';
  const price = getCodingPlanPriceParts(plan.costKiloCredits, plan.billingPeriodDays, plan.planId);
  const subscribeBlocked = hasBlockingMiniMaxKey || hasLiveProviderSubscription;

  return (
    <AvailableProductCard
      icon={<CodingPlanIcon providerName={plan.providerName} />}
      title={`${plan.providerName} ${plan.name}`}
      price={price}
      status={isSoldOut ? 'Sold out' : undefined}
      features={plan.features}
      featureLayout={compact ? 'single' : 'responsive'}
      cta={
        isSoldOut
          ? {
              label: plan.notificationRequested
                ? 'Notification saved'
                : notificationPending
                  ? 'Saving request...'
                  : 'Notify me when available',
              onClick: plan.notificationRequested ? undefined : onRequestNotification,
              disabled: plan.notificationRequested || notificationSaving,
              busy: notificationPending,
              trailingIcon: plan.notificationRequested ? <CircleCheck aria-hidden /> : undefined,
              visualStyle: 'solid-neutral',
            }
          : {
              label: 'Subscribe with Kilo Credits',
              onClick: onSubscribe,
              disabled: subscribeBlocked,
            }
      }
    />
  );
}

function CodingPlanIcon({ providerName }: { providerName: string }) {
  return providerName === 'MiniMax' ? <MiniMaxPlanIcon /> : <Code2 className="size-5" />;
}
