import type { ReactNode } from 'react';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { Button } from '@/components/ui/button';

export type OrgKiloPassCardAgreement = {
  status: string;
  tierName: string;
  paidSeatCount: number;
  price: string;
  paidThrough: string;
  billingDateLabel: string;
  isTerminal?: boolean;
  warningTone?: 'warning' | 'info';
  statusNote?: string | null;
};

export function OrgKiloPassSubscriptionCard({
  organizationId,
  paidSeatCount,
  agreement,
  availableActionLabel = 'Add Kilo Pass',
  availableDetails,
  conditionAlert,
  seatSubscriptionState,
  onRetrySeatSubscription,
}: {
  organizationId: string;
  paidSeatCount: number;
  agreement?: OrgKiloPassCardAgreement;
  availableActionLabel?: string;
  availableDetails?: ReactNode;
  conditionAlert?: ReactNode;
  seatSubscriptionState: 'active' | 'inactive' | 'unavailable';
  onRetrySeatSubscription?: () => void;
}) {
  if (agreement) {
    return (
      <div className="space-y-3">
        {conditionAlert}
        <SubscriptionCard
          icon={<KiloPassIcon className="size-5" />}
          title="Kilo Pass for Organizations"
          subtitle={`${agreement.tierName} add-on · ${agreement.paidSeatCount} paid seats covered`}
          status={agreement.status}
          price={agreement.price}
          billingDate={agreement.paidThrough}
          billingDateLabel={agreement.billingDateLabel}
          paymentMethod="Stripe"
          href={`/organizations/${organizationId}/subscriptions/kilo-pass`}
          isTerminal={agreement.isTerminal}
          warningTone={agreement.warningTone}
          statusNote={agreement.statusNote}
        />
      </div>
    );
  }

  return (
    <AvailableProductCard
      icon={<KiloPassIcon className="size-4" />}
      title="Kilo Pass for Organizations add-on"
      price={{
        qualifier: 'From',
        amount: '$19',
        cadenceLabel: 'per paid seat/month, billed with seats',
      }}
      status={seatSubscriptionState === 'unavailable' ? undefined : 'Available'}
      features={[
        seatSubscriptionState === 'unavailable'
          ? 'Monthly Credits for each paid seat'
          : `Monthly Credits for all ${paidSeatCount} paid seats`,
        'One Credit tier for your organization',
        'Manage all passes from one subscription',
        'Seat and Kilo Pass charges on one invoice',
      ]}
      cta={
        seatSubscriptionState !== 'active'
          ? { label: availableActionLabel, disabled: true }
          : {
              label: availableActionLabel,
              href: `/organizations/${organizationId}/subscriptions/kilo-pass/setup`,
            }
      }
      details={
        seatSubscriptionState !== 'active' ? (
          <div className="space-y-2">
            {seatSubscriptionState === 'unavailable' ? (
              <>
                <p className="type-label text-muted-foreground">
                  Unable to verify your seat subscription. Try again before adding Kilo Pass.
                </p>
                {onRetrySeatSubscription ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRetrySeatSubscription}
                  >
                    Retry seat status
                  </Button>
                ) : null}
              </>
            ) : (
              <p className="type-label text-muted-foreground">
                Kilo Pass for Organizations is added to a paid seat subscription. Subscribe to seats
                first, then add Kilo Pass.
              </p>
            )}
            {availableDetails}
          </div>
        ) : (
          availableDetails
        )
      }
    />
  );
}
