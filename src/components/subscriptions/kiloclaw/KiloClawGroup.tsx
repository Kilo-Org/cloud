'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatDateLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
  isInfoStatus,
  isKiloclawTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';

export function KiloClawGroup({ showTerminal }: { showTerminal: boolean }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.kiloclaw.listPersonalSubscriptions.queryOptions());
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
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
    >
      {visibleSubscriptions.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {visibleSubscriptions.map(subscription => (
            <SubscriptionCard
              key={subscription.instanceId}
              icon={<KiloCrabIcon className="h-5 w-5" />}
              title={subscription.instanceName ?? 'KiloClaw instance'}
              subtitle={subscription.sandboxId}
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
        <div className="grid gap-3 lg:grid-cols-2">
          <AvailableProductCard
            icon={<KiloCrabIcon className="h-5 w-5" />}
            title="KiloClaw Standard"
            description="Month-to-month hosting for your personal KiloClaw instance."
            price="$9.00/month"
            cta={{ label: 'Open KiloClaw', href: '/claw' }}
          />
          <AvailableProductCard
            icon={<KiloCrabIcon className="h-5 w-5" />}
            title="KiloClaw Commit"
            description="Lower effective monthly cost with a 6-month commitment."
            price="$48.00 / 6 months"
            badge="Best value"
            cta={{ label: 'Open KiloClaw', href: '/claw' }}
          />
        </div>
      ) : null}
    </SubscriptionGroup>
  );
}
