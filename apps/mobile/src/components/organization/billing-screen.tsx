import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  getAutoTopUpLinkLabel,
  getAutoTopUpReadout,
  getOrgSubscriptionState,
  getScheduledSeatChange,
  seatCountReadout,
} from '@/components/organization/billing-model';
import { BillingWebSettings } from '@/components/organization/billing-web-settings';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { getOrgKiloPassRowState } from '@/components/organization/org-kilo-pass-row-state';
import { OrganizationPlanRefusal } from '@/components/organization/plan-refusal';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useCanLinkExternalPurchase } from '@/lib/billing/external-purchase-link';
import { WEB_BASE_URL } from '@/lib/config';
import { organizationBillingUrl } from '@/lib/credits/add-credits-destination';
import { openExternalUrl } from '@/lib/external-link';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgKiloPassSummary,
  useOrgParentLink,
} from '@/lib/hooks/use-organization-queries';
import {
  useOrgAutoTopUpConfig,
  useOrgSeats,
  useOrgSeatSubscription,
} from '@/lib/hooks/use-org-billing-queries';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

/**
 * Two rows' worth of loading shape. A billing readout that grows its card when
 * the answer lands would move every block under it, so the placeholder holds
 * the same height the rows will.
 */
function BillingCardSkeleton() {
  return (
    <RowGroup>
      <RowSkeleton />
      <RowSkeleton />
    </RowGroup>
  );
}

/** A block whose read failed, with the retry that asks it again. */
function BillingCardError({
  onRetry,
  isRetrying,
}: Readonly<{ onRetry: () => void; isRetrying: boolean }>) {
  const { t } = useTranslation();
  return (
    <Card>
      <Text variant="muted">{t('common.somethingWentWrong')}</Text>
      <Button
        variant="outline"
        size="sm"
        className={STATE_ACTION_CLASS}
        onPress={onRetry}
        loading={isRetrying}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </Card>
  );
}

/**
 * The organization's billing readout: the plan and its subscription state, the
 * seats in use, auto top-up, and the organization's Kilo Pass.
 *
 * Nothing here changes a plan. Buying seats, changing the plan and setting up
 * auto top-up exist only on the web, so those controls lead there — a link only
 * on an iOS build in the US storefront, a statement of where the setting lives
 * everywhere else, the rule `useCanLinkExternalPurchase` owns.
 */
export function OrganizationBillingScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const hasBillingRole = isMoneyRole(role);
  const subscription = useOrgSeatSubscription(organizationId, hasBillingRole);
  const seats = useOrgSeats(organizationId);
  const autoTopUp = useOrgAutoTopUpConfig(organizationId, hasBillingRole);
  const { parentLink } = useOrgParentLink(organizationId, org?.parentOrganizationId);
  const kiloPassSummary = useOrgKiloPassSummary(
    organizationId,
    hasBillingRole && parentLink === null
  );
  // The storefront rule that decides whether the lapsed-plan banner may link to
  // the web billing page. Read with the other hooks, before the boundary's
  // early returns.
  const canLinkBilling = useCanLinkExternalPurchase();

  const screenTitle = t('organization.billing.title');

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={screenTitle} backFallback={ORGANIZATION_HUB_PATH} />;
  }

  if (!hasBillingRole) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={screenTitle} backFallback={ORGANIZATION_HUB_PATH} />
        <PermissionDenied description={t('organization.billing.permissionDenied')} />
      </View>
    );
  }

  const planEnded = org.isTrialExpiredForEnforcement;
  const planName =
    org.plan === 'enterprise'
      ? t('organization.hub.planEnterprise')
      : t('organization.hub.planTeams');
  const subscriptionsUrl = `${WEB_BASE_URL}/organizations/${organizationId}/subscriptions`;
  const changePlanLabel = t('organization.billing.changePlan');
  // The banner is the one place the change-plan destination belongs while the
  // plan has lapsed and the surface may link, so the card's copy of it would
  // only outweigh the banner. One value feeds both, so the two cannot drift.
  // A surface that gets text only keeps the card's copy: its banner has no
  // action.
  const changePlanOnBanner = planEnded && canLinkBilling;

  const subscriptionState = subscription.data ? getOrgSubscriptionState(subscription.data) : null;
  const scheduledSeatChange = subscription.data ? getScheduledSeatChange(subscription.data) : null;
  // The list entry already carries the same seat numbers, so the row paints
  // settled on the first frame and the query only corrects it if they moved.
  // The shared readout prints a total only when the seats read confirms the
  // organization bought some, so the row does not change shape when it lands.
  const seatsInUse = seats.data?.usedSeats ?? org.seatCount.used;
  const seatsPurchased = seats.data?.totalSeats ?? org.seatCount.total;
  const seatCountValue = seatCountReadout({
    seatsEnforced: org.requireSeats,
    used: seatsInUse,
    total: seatsPurchased,
  });

  const autoTopUpReadout = autoTopUp.data ? getAutoTopUpReadout(autoTopUp.data) : null;

  // A child organization has no Kilo Pass of its own; an unknown parent link
  // keeps the row, which renders its loading state.
  const isChildOrganization = parentLink != null;
  const kiloPassRowState = isChildOrganization
    ? null
    : getOrgKiloPassRowState({
        data: kiloPassSummary.data,
        isError: kiloPassSummary.isError,
      });

  const renderSubscriptionState = (): ReactNode => {
    if (subscription.isPending) {
      return <BillingCardSkeleton />;
    }
    if (subscription.isError) {
      return (
        <BillingCardError
          onRetry={() => void subscription.refetch()}
          isRetrying={subscription.isFetching}
        />
      );
    }
    if (subscriptionState == null) {
      return <BillingCardSkeleton />;
    }
    return (
      <RowGroup>
        <KvRow label={t('organization.hub.plan')} value={planName} valueFace="text" />
        <KvRow
          label={t('organization.billing.state')}
          value={subscriptionState.label}
          valueFace="text"
          valueTone={subscriptionState.tone}
        />
        {scheduledSeatChange == null ? null : (
          <KvRow
            label={t('kiloPass.manage.scheduledChange')}
            value={scheduledSeatChange}
            valueFace="text"
          />
        )}
      </RowGroup>
    );
  };

  const renderAutoTopUpState = (): ReactNode => {
    if (autoTopUp.isPending) {
      return <BillingCardSkeleton />;
    }
    if (autoTopUp.isError) {
      return (
        <BillingCardError
          onRetry={() => void autoTopUp.refetch()}
          isRetrying={autoTopUp.isFetching}
        />
      );
    }
    if (autoTopUpReadout == null) {
      return <BillingCardSkeleton />;
    }
    return (
      <RowGroup>
        <KvRow
          label={t('common.status')}
          value={autoTopUpReadout.status}
          valueFace="text"
          valueTone={autoTopUpReadout.enabled ? 'good' : 'muted'}
        />
        <KvRow
          label={t('organization.billing.autoTopUpAmount')}
          value={autoTopUpReadout.amount}
          valueFace="numeric"
        />
        <KvRow
          label={t('organization.billing.autoTopUpThreshold')}
          value={autoTopUpReadout.threshold}
          valueFace="numeric"
        />
      </RowGroup>
    );
  };

  const renderKiloPassState = () => {
    if (kiloPassRowState == null) {
      return null;
    }
    if (kiloPassRowState.loading) {
      return <BillingCardSkeleton />;
    }
    return (
      <RowGroup>
        <KvRow
          label={t('kiloPass.title')}
          value={kiloPassRowState.subtitle}
          valueFace="text"
          valueTone={kiloPassRowState.attention ? 'warn' : 'default'}
          trailing={
            kiloPassRowState.action === 'retry' ? (
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  void kiloPassSummary.refetch();
                }}
                loading={kiloPassSummary.isFetching}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            ) : undefined
          }
        />
      </RowGroup>
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={screenTitle} backFallback={ORGANIZATION_HUB_PATH} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {/* A lapsed plan blocks every new session, so it is stated before the
            numbers. Only a billing role reaches this screen, and a surface the
            storefront rule keeps from linking shows no action here: the
            manage-on-web block below carries the destination as text. */}
        {planEnded ? (
          <OrganizationPlanRefusal
            message={t('organization.hub.planEnded')}
            action={
              changePlanOnBanner
                ? {
                    label: changePlanLabel,
                    onPress: () => {
                      void openExternalUrl(subscriptionsUrl, { label: changePlanLabel });
                    },
                  }
                : undefined
            }
          />
        ) : null}

        <Section label={t('organization.billing.subscription')}>
          {renderSubscriptionState()}
        </Section>

        <Section label={t('organization.billing.seats')}>
          <RowGroup>
            <KvRow
              label={t('organization.billing.seatsInUse')}
              value={seatCountValue}
              valueFace="numeric"
            />
          </RowGroup>
        </Section>

        <Section label={t('organization.billing.autoTopUp')}>{renderAutoTopUpState()}</Section>

        {renderKiloPassState()}

        <BillingWebSettings
          subscriptionsUrl={subscriptionsUrl}
          planLabel={changePlanOnBanner ? null : changePlanLabel}
          autoTopUpUrl={organizationBillingUrl(organizationId)}
          autoTopUpLabel={getAutoTopUpLinkLabel(autoTopUp.data?.enabled)}
        />
      </TabScreenScrollView>
    </View>
  );
}
