import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { CenteredState } from '@/components/centered-state';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import {
  KiloPassBillingHistorySection,
  KiloPassCreditHistorySection,
} from '@/components/kilo-pass/kilo-pass-history-sections';
import {
  KiloPassManagementSections,
  type KiloPassScheduledChange,
} from '@/components/kilo-pass/kilo-pass-management';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Crown } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSheetHeaderTopClearance } from '@/lib/form-sheet';
import {
  type KiloPassBillingHistory,
  type KiloPassCreditHistory,
  useKiloPassBillingHistory,
  useKiloPassCreditHistory,
} from '@/lib/hooks/use-kilo-pass-history';
import { isStoreManagedPass, type KiloPassSubscriptionState } from '@/lib/kilo-pass/management';
import { getKiloPassDetailState, type KiloPassDetail } from '@/lib/kilo-pass/state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

/**
 * The screen's frame: one header for every state, above the body it owns. The
 * route presents as a full-screen modal on Android, so the sheet edge reaches
 * the window top there and this frame clears the status-bar inset itself; the
 * iOS page sheet presents below the status bar, reserves nothing, and the
 * header keeps its own grabber clearance.
 */
function KiloPassFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const windowTopClearance = useSheetHeaderTopClearance('android-window-top');
  const surfaceOwnsWindowTop = windowTopClearance > 0;
  return (
    <View className="flex-1 bg-background">
      {/* `safeAreaTop` only draws the inset inside the header, so the surface
          that owns the window top pads it here instead. */}
      <View style={surfaceOwnsWindowTop ? { paddingTop: windowTopClearance } : undefined}>
        <ScreenHeader
          title={t('kiloPass.title')}
          modal
          safeAreaTop={!surfaceOwnsWindowTop}
          className={surfaceOwnsWindowTop ? 'pt-2' : undefined}
        />
      </View>
      {children}
    </View>
  );
}

function KiloPassLoadingScreen() {
  return (
    <KiloPassFrame>
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {/* The page prints once, at its final height: every block the pass
            state introduces is held until it has one answer, so this skeleton
            stands in for a page that would otherwise grow under the reader and
            push the ledgers down. Each block is the primitive it stands for. */}
        <View className="gap-1">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="h-4 w-24 rounded" />
        </View>
        <RowGroup>
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </RowGroup>
        <Card>
          <Skeleton className="h-24 w-full rounded-lg" />
        </Card>
      </DetailScreenScrollView>
    </KiloPassFrame>
  );
}

function KiloPassErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <KiloPassFrame>
      <CenteredState>
        <View className="items-center gap-3 px-4">
          <Text className="text-center font-semibold text-foreground">
            {t('kiloPass.unavailable')}
          </Text>
          <Text variant="muted" className="text-center text-sm">
            {t('kiloPass.couldNotLoad')}
          </Text>
          <Button
            accessibilityLabel={t('kiloPass.retryLoading')}
            onPress={onRetry}
            variant="outline"
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      </CenteredState>
    </KiloPassFrame>
  );
}

/**
 * A resolved pass: the same details the web console prints, the actions the
 * subscriber can take from the phone, and both ledgers.
 */
function KiloPassDetailBody({
  subscription,
  detail,
  scheduledChange,
  creditHistory,
  billingHistory,
}: Readonly<{
  subscription: KiloPassSubscriptionState;
  detail: Extract<KiloPassDetail, { kind: 'active' }>;
  scheduledChange: KiloPassScheduledChange | null;
  creditHistory: KiloPassCreditHistory;
  billingHistory: KiloPassBillingHistory;
}>) {
  return (
    <KiloPassFrame>
      <DetailScreenScrollView contentContainerClassName={SCREEN_BODY_CLASS}>
        <View className="gap-1">
          <Text variant="large">{detail.planLabel}</Text>
          <Text
            variant="muted"
            className={detail.statusTone === 'danger' ? 'text-destructive' : undefined}
          >
            {detail.statusLabel}
          </Text>
        </View>
        {detail.rows.length > 0 ? (
          <RowGroup>
            {detail.rows.map(row => (
              <KvRow
                key={row.id}
                label={row.label}
                value={row.value}
                valueFace={row.id === 'renewal' ? 'text' : 'numeric'}
                valueDirection={row.id === 'renewal' ? undefined : 'ltr'}
              />
            ))}
          </RowGroup>
        ) : null}
        <KiloPassManagementSections subscription={subscription} scheduledChange={scheduledChange} />
        <KiloPassCreditHistorySection history={creditHistory} />
        {/* A store-sold pass has no Stripe invoices, and the read rejects one. */}
        {!isStoreManagedPass(subscription) && (
          <KiloPassBillingHistorySection history={billingHistory} />
        )}
      </DetailScreenScrollView>
    </KiloPassFrame>
  );
}

function KiloPassMessageBody({ message }: { message: string }) {
  return (
    <KiloPassFrame>
      <View className="flex-1 justify-center">
        <EmptyState placement="static" icon={Crown} title={message} />
      </View>
    </KiloPassFrame>
  );
}

/**
 * A lapsed pass keeps the receipts: the plan it was, the day it stopped, and
 * both ledgers the account already paid for. It offers no action, because the
 * app sells nothing here and the pass can no longer change.
 */
function KiloPassEndedBody({
  subscription,
  detail,
  creditHistory,
  billingHistory,
}: Readonly<{
  subscription: KiloPassSubscriptionState;
  detail: Extract<KiloPassDetail, { kind: 'ended' }>;
  creditHistory: KiloPassCreditHistory;
  billingHistory: KiloPassBillingHistory;
}>) {
  return (
    <KiloPassFrame>
      <DetailScreenScrollView contentContainerClassName={SCREEN_BODY_CLASS}>
        <View className="gap-1">
          <Text variant="large">{detail.planLabel}</Text>
          <Text variant="muted">{detail.endedLabel}</Text>
        </View>
        <KiloPassCreditHistorySection history={creditHistory} />
        {/* A store-sold pass has no Stripe invoices, and the read rejects one. */}
        {!isStoreManagedPass(subscription) && (
          <KiloPassBillingHistorySection history={billingHistory} />
        )}
      </DetailScreenScrollView>
    </KiloPassFrame>
  );
}

export function KiloPassSubscriptionScreen() {
  const trpc = useTRPC();
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const subscription = stateQuery.data?.subscription;
  const detail = getKiloPassDetailState({
    subscription,
    isError: stateQuery.isError,
    isPending: stateQuery.isPending,
  });
  const { t } = useTranslation();

  // The pass state introduces three more reads, and each one adds or removes
  // height below the state rows. Hold the page until every read the state shows
  // has answered: a ledger or a scheduled plan change that landed afterwards
  // would push the blocks under it. An ended page waits on its own ledgers the
  // same way, so its last row does not move once it prints.
  const hasDetail = (detail.kind === 'active' || detail.kind === 'ended') && subscription != null;
  const activeDetail = detail.kind === 'active' && subscription != null;
  const storeManaged = subscription != null && isStoreManagedPass(subscription);
  const creditHistory = useKiloPassCreditHistory(hasDetail);
  const billingHistory = useKiloPassBillingHistory(hasDetail && !storeManaged);
  // The page waits on this read before it prints, so it must settle even while
  // the online manager reports offline: a paused query never errors and never
  // answers, and the screen would hold its loading state with no retry.
  const scheduledChangeQuery = useQuery({
    ...trpc.kiloPass.getScheduledChange.queryOptions(),
    enabled: activeDetail && !storeManaged,
    ...SETTLE_WHILE_OFFLINE,
  });
  // A store-managed pass has neither a Stripe schedule nor invoices, so those
  // two stay disabled and their pending status says nothing.
  const blocksPending =
    (hasDetail &&
      (creditHistory.query.isPending || (!storeManaged && billingHistory.query.isPending))) ||
    (activeDetail && !storeManaged && scheduledChangeQuery.isPending);

  if (detail.kind === 'loading' || blocksPending) {
    return <KiloPassLoadingScreen />;
  }
  if (detail.kind === 'error') {
    return (
      <KiloPassErrorScreen
        onRetry={() => {
          void stateQuery.refetch();
        }}
      />
    );
  }
  if (detail.kind === 'none') {
    return <KiloPassMessageBody message={t('kiloPass.notAvailableInApp')} />;
  }
  if (subscription == null) {
    // A detail — active or ended — is derived from a subscription, so this only
    // narrows the type; the message keeps the screen total rather than throwing
    // on it.
    return <KiloPassMessageBody message={t('kiloPass.notAvailableInApp')} />;
  }
  if (detail.kind === 'ended') {
    return (
      <KiloPassEndedBody
        subscription={subscription}
        detail={detail}
        creditHistory={creditHistory}
        billingHistory={billingHistory}
      />
    );
  }
  return (
    <KiloPassDetailBody
      subscription={subscription}
      detail={detail}
      scheduledChange={scheduledChangeQuery.data?.scheduledChange ?? null}
      creditHistory={creditHistory}
      billingHistory={billingHistory}
    />
  );
}
