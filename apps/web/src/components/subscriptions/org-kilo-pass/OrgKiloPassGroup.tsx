'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDateLabel } from '../helpers';
import { formatOrgPassMoney } from './formatters';
import { toCondition, toOrgKiloPassTerms } from './mappers';
import { OrgKiloPassGroupShell } from './OrgKiloPassGroupShell';
import { OrgKiloPassSubscriptionCard } from './OrgKiloPassSubscriptionCard';

export function OrgKiloPassGroup({
  organizationId,
  showTerminal = false,
  unframed = false,
}: {
  organizationId: string;
  showTerminal?: boolean;
  unframed?: boolean;
}) {
  const trpc = useTRPC();
  const organizationQuery = useOrganizationWithMembers(organizationId, {
    enabled: Boolean(organizationId),
  });
  const summaryQuery = useQuery(
    trpc.organizations.kiloPass.summary.queryOptions(
      { organizationId },
      { enabled: Boolean(organizationId) }
    )
  );
  const seatSubscriptionQuery = useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId },
      { enabled: Boolean(organizationId) }
    )
  );
  const organization = organizationQuery.data;
  const summary = summaryQuery.data;
  const agreement = summary?.agreement;
  const terms = agreement ? toOrgKiloPassTerms(agreement) : null;
  const commercialState = summary?.commercialState ?? undefined;
  const condition = toCondition(summary?.processingCondition ?? null);
  const isEnded = commercialState === 'ended';
  const hasVisibleAgreement = Boolean(agreement && terms && (!isEnded || showTerminal));
  const hasRequiredQueryError = summaryQuery.isError || organizationQuery.isError;
  const seatSubscriptionState =
    seatSubscriptionQuery.isSuccess && seatSubscriptionQuery.data
      ? seatSubscriptionQuery.data.latestSeatPurchaseStatus === 'active'
        ? 'active'
        : 'inactive'
      : 'unavailable';

  return (
    <OrgKiloPassGroupShell
      isLoading={
        !hasRequiredQueryError &&
        (summaryQuery.isPending ||
          organizationQuery.isPending ||
          (!hasVisibleAgreement &&
            (seatSubscriptionQuery.isPending || seatSubscriptionQuery.isFetching)))
      }
      isError={hasRequiredQueryError}
      error={summaryQuery.error ?? organizationQuery.error}
      unframed={unframed}
      onRetry={() => {
        void summaryQuery.refetch();
        void organizationQuery.refetch();
        void seatSubscriptionQuery.refetch();
      }}
    >
      <OrgKiloPassSubscriptionCard
        organizationId={organizationId}
        paidSeatCount={agreement?.paidSeatCount ?? organization?.seat_count ?? 0}
        agreement={
          hasVisibleAgreement && agreement && terms
            ? {
                status: commercialState ?? 'pending_payment',
                tierName: terms.tierName,
                paidSeatCount: agreement.paidSeatCount,
                price:
                  agreement.cadence === 'yearly'
                    ? `${formatOrgPassMoney(terms.pricePerPassUsd * agreement.paidSeatCount)}/mo equivalent · billed annually`
                    : `${formatOrgPassMoney(terms.pricePerPassUsd * agreement.paidSeatCount)}/month`,
                paidThrough: formatDateLabel(agreement.paidThrough, 'Waiting for payment'),
                billingDateLabel:
                  commercialState === 'cancel_at_period_end' ? 'Ends' : 'Covered through',
                isTerminal: isEnded,
                warningTone:
                  condition ||
                  commercialState === 'pending_payment' ||
                  commercialState === 'cancel_at_period_end'
                    ? 'warning'
                    : undefined,
                statusNote: condition?.description,
              }
            : undefined
        }
        seatSubscriptionState={seatSubscriptionState}
        onRetrySeatSubscription={() => void seatSubscriptionQuery.refetch()}
        availableActionLabel={isEnded ? 'Add Kilo Pass again' : 'Add Kilo Pass'}
        availableDetails={
          isEnded && agreement ? (
            <p className="type-label text-muted-foreground">
              Your previous Kilo Pass for Organizations ended
              {agreement.paidThrough ? ` on ${formatDateLabel(agreement.paidThrough)}` : ''}.
              {seatSubscriptionState === 'active'
                ? ' Monthly Credits can restart right away.'
                : null}
            </p>
          ) : undefined
        }
      />
    </OrgKiloPassGroupShell>
  );
}
