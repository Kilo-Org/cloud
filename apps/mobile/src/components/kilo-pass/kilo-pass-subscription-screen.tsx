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
import { Crown } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
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
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

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
      <View className="flex-1 px-5">
        {/* The scroller applies the landscape side insets, so a cutout window
            cannot paint the reserved blocks under the sensor area. */}
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="grow gap-5 px-1 py-4"
          showsVerticalScrollIndicator={false}
        >
          {/* The page prints once, at its final height: every block the pass
              state introduces is held until it has one answer, so this
              skeleton stands in for a page that would otherwise grow under
              the reader and push the ledgers down. */}
          <View className="gap-1">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="h-4 w-24 rounded" />
          </View>
          <Skeleton className="h-[132px] w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-[104px] w-full rounded-lg" />
          <Skeleton className="h-[104px] w-full rounded-lg" />
        </DetailScreenScrollView>
      </View>
    </KiloPassFrame>
  );
}

function KiloPassErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <KiloPassFrame>
      <CenteredState>
        <View className="items-center gap-3 px-6">
          <Text className="text-center font-semibold text-foreground">
            {t('kiloPass.unavailable')}
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
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
      <DetailScreenScrollView contentContainerClassName="grow gap-5 px-5 pb-8">
        <View className="gap-1">
          <Text className="text-base font-semibold text-foreground">{detail.planLabel}</Text>
          <Text
            className={cn(
              'text-sm',
              detail.statusTone === 'danger' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {detail.statusLabel}
          </Text>
        </View>
        {detail.rows.length > 0 ? (
          <View className="rounded-lg bg-secondary px-3">
            {detail.rows.map((row, index) => (
              <KvRow
                key={row.id}
                label={row.label}
                value={row.value}
                last={index === detail.rows.length - 1}
                valueFace={row.id === 'renewal' ? 'text' : 'numeric'}
                valueDirection={row.id === 'renewal' ? undefined : 'ltr'}
              />
            ))}
          </View>
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
  // height below the state rows. Hold the page until all three answer so its
  // first frame is its last: a ledger or a scheduled plan change that landed
  // afterwards would push the blocks under it.
  const isDetail = detail.kind === 'active' && subscription != null;
  const storeManaged = subscription != null && isStoreManagedPass(subscription);
  const creditHistory = useKiloPassCreditHistory(isDetail);
  const billingHistory = useKiloPassBillingHistory(isDetail && !storeManaged);
  const scheduledChangeQuery = useQuery({
    ...trpc.kiloPass.getScheduledChange.queryOptions(),
    enabled: isDetail && !storeManaged,
  });
  // A store-managed pass has neither a Stripe schedule nor invoices, so those
  // two stay disabled and their pending status says nothing.
  const blocksPending =
    isDetail &&
    (creditHistory.query.isPending ||
      (!storeManaged && (billingHistory.query.isPending || scheduledChangeQuery.isPending)));

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
  if (detail.kind === 'ended') {
    return <KiloPassMessageBody message={t('kiloPass.purchaseUnavailableEnded')} />;
  }
  if (subscription == null) {
    // An active detail is derived from a subscription, so this only narrows the
    // type; the message keeps the screen total rather than throwing on it.
    return <KiloPassMessageBody message={t('kiloPass.notAvailableInApp')} />;
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
