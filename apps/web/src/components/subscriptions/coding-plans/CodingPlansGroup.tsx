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
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { MiniMaxPlanIcon } from './MiniMaxPlanIcon';

const TOKEN_PLAN_PLUS_BENEFITS = [
  'Kilo automatically configures MiniMax in your BYOK settings.',
  '~1.7B tokens per month of M3 usage.',
  'Full access to the MiniMax model family (M3 / M2.7 / image / speech / music).',
  '1M context window — built for long documents and large codebases.',
  'Native multimodal understanding: image and video input.',
  'Run 3–4 concurrent agents.',
  'Access the web search MCP.',
  'Text, image, speech, and music share one quota.',
];

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
  const hasExistingMiniMaxKey = byokQuery.data?.some(key => key.provider_id === 'minimax') ?? false;
  const selectedPlan = catalog.find(plan => plan.planId === subscriptionRequest?.planId) ?? null;
  const nonTerminalSubscriptions = subscriptions.filter(
    subscription => !isCodingPlanTerminal(subscription.status)
  );
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
          toast.error('Token Plan Plus is currently sold out.');
          return;
        }
        toast.error(error.message || 'Unable to activate Coding Plan subscription');
      },
    })
  );
  const notificationMutation = useMutation(
    trpc.codingPlans.requestAvailabilityNotification.mutationOptions({
      onSuccess: async () => {
        toast.success('We will notify you when Token Plan Plus is available.');
        await queryClient.invalidateQueries({ queryKey: trpc.codingPlans.catalog.queryKey() });
      },
      onError: async error => {
        if (error.message.includes('currently available')) {
          await queryClient.invalidateQueries({ queryKey: trpc.codingPlans.catalog.queryKey() });
          toast.info('Token Plan Plus is available now.');
          return;
        }
        toast.error(error.message || 'Unable to save notification request.');
      },
    })
  );

  function openSubscribeDialog(planId: string) {
    if (hasExistingMiniMaxKey) {
      return;
    }
    setSubscriptionRequest({ planId, idempotencyKey: crypto.randomUUID() });
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
      hasExistingMiniMaxKey ||
      subscribeMutation.isPending
    ) {
      return;
    }

    subscribeMutation.mutate({
      planId: selectedPlan.planId,
      idempotencyKey: subscriptionRequest.idempotencyKey,
    });
  }

  const needsPurchaseData = !subscriptionQuery.isLoading && nonTerminalSubscriptions.length === 0;
  const isLoading =
    subscriptionQuery.isLoading ||
    (needsPurchaseData && (catalogQuery.isLoading || byokQuery.isLoading));
  const isError =
    subscriptionQuery.isError || (needsPurchaseData && (catalogQuery.isError || byokQuery.isError));
  const error =
    subscriptionQuery.error ?? (needsPurchaseData ? (catalogQuery.error ?? byokQuery.error) : null);

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

        {nonTerminalSubscriptions.length === 0 ? (
          <div className="space-y-4">
            {catalog.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No Coding Plans are currently available.
              </p>
            ) : (
              <div className="grid gap-4">
                {catalog.map(plan => (
                  <CodingPlanOfferCard
                    key={plan.planId}
                    plan={plan}
                    hasExistingMiniMaxKey={hasExistingMiniMaxKey}
                    notificationPending={
                      notificationMutation.isPending &&
                      notificationMutation.variables?.planId === plan.planId
                    }
                    notificationSaving={notificationMutation.isPending}
                    onSubscribe={() => openSubscribeDialog(plan.planId)}
                    onRequestNotification={() =>
                      notificationMutation.mutate({ planId: plan.planId })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}
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
  providerName: string;
  name: string;
  costKiloCredits: number;
  billingPeriodDays: number;
  availabilityStatus: 'available' | 'sold_out';
  notificationRequested: boolean;
};

function CodingPlanOfferCard({
  plan,
  hasExistingMiniMaxKey,
  notificationPending,
  notificationSaving,
  onSubscribe,
  onRequestNotification,
}: {
  plan: CodingPlanOffer;
  hasExistingMiniMaxKey: boolean;
  notificationPending: boolean;
  notificationSaving: boolean;
  onSubscribe: () => void;
  onRequestNotification: () => void;
}) {
  const isSoldOut = plan.availabilityStatus === 'sold_out';
  const price = getCodingPlanPriceParts(plan.costKiloCredits, plan.billingPeriodDays, plan.planId);

  return (
    <AvailableProductCard
      icon={<CodingPlanIcon providerName={plan.providerName} />}
      title={`${plan.providerName} ${plan.name}`}
      price={price}
      status={isSoldOut ? 'Sold out' : undefined}
      features={plan.planId === 'minimax-token-plan-plus' ? TOKEN_PLAN_PLUS_BENEFITS : undefined}
      cta={
        isSoldOut
          ? {
              label: plan.notificationRequested
                ? 'You will be notified when this plan is available again.'
                : notificationPending
                  ? 'Saving request...'
                  : 'Notify me when available',
              onClick: plan.notificationRequested ? undefined : onRequestNotification,
              disabled: plan.notificationRequested || notificationSaving,
              busy: notificationPending,
              trailingIcon: plan.notificationRequested ? <CircleCheck aria-hidden /> : undefined,
            }
          : {
              label: 'Subscribe with Kilo Credits',
              onClick: onSubscribe,
              disabled: hasExistingMiniMaxKey,
            }
      }
      details={
        isSoldOut ? (
          <p className="border-border text-muted-foreground rounded-lg border px-4 py-3 text-sm">
            Currently sold out. More {plan.providerName} capacity is coming soon.
          </p>
        ) : hasExistingMiniMaxKey ? (
          <Alert variant="warning">
            <AlertDescription>
              MiniMax is already configured in BYOK. Delete your existing MiniMax key in{' '}
              <Link href="/byok" className="underline underline-offset-4">
                BYOK settings
              </Link>{' '}
              before subscribing, including if it is disabled.
            </AlertDescription>
          </Alert>
        ) : null
      }
    />
  );
}

function CodingPlanIcon({ providerName }: { providerName: string }) {
  return providerName === 'MiniMax' ? <MiniMaxPlanIcon /> : <Code2 className="size-5" />;
}
