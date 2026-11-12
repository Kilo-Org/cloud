import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  formatSeatCount,
  getAutoTopUpReadout,
  getOrgSubscriptionState,
  getScheduledSeatChange,
} from '@/components/organization/billing-model';
import { ExternalBillingLink } from '@/components/organization/external-billing-link';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { getOrgKiloPassRowState } from '@/components/organization/org-kilo-pass-row-state';
import { OrganizationPlanRefusal } from '@/components/organization/plan-refusal';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { WEB_BASE_URL } from '@/lib/config';
import { organizationBillingUrl } from '@/lib/credits/add-credits-destination';
import { externalBillingAction } from '@/lib/external-billing-action';
import { openExternalUrl } from '@/lib/external-link';
import { formatNumber } from '@/lib/format';
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

/** A settings block: the raised surface the hub's own cards paint. */
function BillingCard({ children }: Readonly<{ children: ReactNode }>) {
  return <View className="rounded-lg bg-secondary px-3">{children}</View>;
}

/**
 * Two rows' worth of loading shape. A billing readout that grows its card when
 * the answer lands would move every block under it, so the placeholder holds
 * the same height the rows will.
 */
function BillingCardSkeleton() {
  return (
    <View className="rounded-lg bg-secondary px-3">
      <View className="gap-3 py-3">
        <Skeleton className="h-4 w-28 rounded bg-muted-soft" />
        <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
      </View>
    </View>
  );
}

/** A block whose read failed, with the retry that asks it again. */
function BillingCardError({
  onRetry,
  isRetrying,
}: Readonly<{ onRetry: () => void; isRetrying: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <Text className="text-sm text-muted-foreground">{t('common.somethingWentWrong')}</Text>
      <Button
        variant="outline"
        size="sm"
        className={STATE_ACTION_CLASS}
        onPress={onRetry}
        loading={isRetrying}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}

function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
      {children}
    </Text>
  );
}

/**
 * The organization's billing readout: the plan and its subscription state, the
 * seats in use, auto top-up, and the organization's Kilo Pass.
 *
 * Nothing here changes a plan. Buying seats, changing the plan and setting up
 * auto top-up exist only on the web, so those controls lead there — a link on
 * Android and plain text on iOS, the App Store rule `ExternalBillingLink`
 * carries.
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

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.billing.title')} />;
  }

  if (!hasBillingRole) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.billing.title')} />
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
  const planChange = externalBillingAction(subscriptionsUrl);

  const subscriptionState = subscription.data ? getOrgSubscriptionState(subscription.data) : null;
  const scheduledSeatChange = subscription.data ? getScheduledSeatChange(subscription.data) : null;
  // The list entry already carries the same seat numbers, so the row paints
  // settled on the first frame and the query only corrects it if they moved.
  let seatCountValue = formatNumber(org.seatCount.used, i18n.language);
  if (org.requireSeats) {
    seatCountValue = formatSeatCount(org.seatCount.used, org.seatCount.total);
  }
  if (seats.data) {
    seatCountValue = formatSeatCount(seats.data.usedSeats, seats.data.totalSeats);
  }

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
      <BillingCard>
        <KvRow
          label={t('organization.hub.plan')}
          value={planName}
          valueFace="text"
          valueTone={planEnded ? 'danger' : 'default'}
        />
        <KvRow
          label={t('organization.billing.state')}
          value={subscriptionState.label}
          valueFace="text"
          valueTone={subscriptionState.tone}
          last={scheduledSeatChange == null}
        />
        {scheduledSeatChange == null ? null : (
          <KvRow
            label={t('organization.billing.scheduledChange')}
            value={scheduledSeatChange}
            valueFace="text"
            last
          />
        )}
      </BillingCard>
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
      <BillingCard>
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
          last
        />
      </BillingCard>
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.billing.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* A lapsed plan blocks every new session, so it is stated before the
            numbers. Only a billing role reaches this screen, and iOS may not
            link to the billing page, so its action is absent there and the
            manage-on-web block below carries the destination as text. */}
        {planEnded ? (
          <OrganizationPlanRefusal
            message={t('organization.hub.planEnded')}
            action={
              planChange.kind === 'link'
                ? {
                    label: changePlanLabel,
                    onPress: () => {
                      void openExternalUrl(planChange.url, { label: changePlanLabel });
                    },
                  }
                : undefined
            }
          />
        ) : null}

        <View className="gap-2">
          <SectionLabel>{t('organization.billing.subscription')}</SectionLabel>
          {renderSubscriptionState()}
        </View>

        <View className="gap-2">
          <SectionLabel>{t('organization.billing.seats')}</SectionLabel>
          <BillingCard>
            <KvRow
              label={t('organization.hub.organizationSeats')}
              value={seatCountValue}
              valueFace="numeric"
              last
            />
          </BillingCard>
        </View>

        <View className="gap-2">
          <SectionLabel>{t('organization.billing.autoTopUp')}</SectionLabel>
          {renderAutoTopUpState()}
        </View>

        {kiloPassRowState == null ? null : (
          <View className="gap-2">
            {kiloPassRowState.loading ? (
              <BillingCardSkeleton />
            ) : (
              <BillingCard>
                <KvRow
                  label={t('kiloPass.title')}
                  value={kiloPassRowState.subtitle}
                  valueFace="text"
                  valueTone={kiloPassRowState.attention ? 'warn' : 'default'}
                  last
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
              </BillingCard>
            )}
          </View>
        )}

        <View className="gap-2">
          <SectionLabel>{t('organization.billing.manageOnWeb')}</SectionLabel>
          <View className="gap-3 rounded-lg bg-secondary p-3">
            <ExternalBillingLink url={subscriptionsUrl} label={changePlanLabel} />
            <ExternalBillingLink
              url={`${subscriptionsUrl}/seats`}
              label={t('organization.billing.buySeats')}
            />
            <ExternalBillingLink
              url={organizationBillingUrl(organizationId)}
              label={t('organization.billing.setupAutoTopUp')}
            />
          </View>
        </View>
      </TabScreenScrollView>
    </View>
  );
}
