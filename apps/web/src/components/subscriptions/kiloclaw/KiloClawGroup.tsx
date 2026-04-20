'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import { KiloClawSubscribeCard } from './KiloClawSubscribeCard';
import {
  formatDateLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
  isInfoStatus,
  isKiloclawTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';

export function KiloClawGroup({
  showTerminal,
  accordionValue,
}: {
  showTerminal: boolean;
  accordionValue?: string;
}) {
  const trpc = useTRPC();
  const query = useQuery(trpc.kiloclaw.listPersonalSubscriptions.queryOptions());
  const summaryQuery = useQuery(trpc.kiloclaw.getPersonalBillingSummary.queryOptions());
  const subscriptions = query.data?.subscriptions ?? [];

  const visibleSubscriptions = subscriptions.filter(
    subscription => !isKiloclawTerminal(subscription.status) || showTerminal
  );
  const nonTerminalSubscriptions = subscriptions.filter(
    subscription => !isKiloclawTerminal(subscription.status)
  );

  return (
    <SubscriptionGroup
      title="KiloClaw"
      description="View hosting subscriptions for your personal KiloClaw instances."
      headerIcon={<KiloCrabIcon className="h-5 w-5" />}
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
      accordionValue={accordionValue}
    >
      {visibleSubscriptions.length > 0 ? (
        <div className="grid gap-3">
          {visibleSubscriptions.map(subscription => (
            <SubscriptionCard
              key={subscription.instanceId}
              icon={<KiloCrabIcon className="h-5 w-5" />}
              title={subscription.instanceName ?? 'KiloClaw instance'}
              subtitle={subscription.instanceName || subscription.instanceId}
              status={subscription.status}
              price={formatKiloclawPrice(subscription.plan)}
              billingDate={formatDateLabel(
                subscription.creditRenewalAt ??
                  subscription.currentPeriodEnd ??
                  subscription.trialEndsAt,
                '—'
              )}
              paymentMethod={formatPaymentSummary({
                paymentSource: subscription.paymentSource,
                hasStripeFunding: subscription.hasStripeFunding,
              })}
              href={`/subscriptions/kiloclaw/${subscription.instanceId}`}
              isTerminal={isKiloclawTerminal(subscription.status)}
              warningTone={
                isWarningStatus(subscription.status)
                  ? 'warning'
                  : isInfoStatus(subscription.status)
                    ? 'info'
                    : undefined
              }
            />
          ))}
        </div>
      ) : nonTerminalSubscriptions.length === 0 ? (
        <KiloClawSubscribeCard
          creditIntroEligible={summaryQuery.data?.creditIntroEligible ?? false}
          hasActiveKiloPass={summaryQuery.data?.hasActiveKiloPass ?? false}
        />
      ) : null}
    </SubscriptionGroup>
  );
}
