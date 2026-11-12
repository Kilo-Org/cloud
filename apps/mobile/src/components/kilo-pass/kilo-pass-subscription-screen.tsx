import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { CenteredState } from '@/components/centered-state';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Crown } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSheetHeaderTopClearance } from '@/lib/form-sheet';
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
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Skeleton className="h-4 w-64 rounded" />
          <Skeleton className="h-[132px] w-full rounded-lg" />
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
 * The two states this surface can show for a resolved account: a pass with the
 * same details the web console prints, or the message that the app does not
 * offer one. Nothing here manages, cancels, or buys a pass.
 */
function KiloPassDetailBody({ detail }: { detail: Extract<KiloPassDetail, { kind: 'active' }> }) {
  return (
    <KiloPassFrame>
      <DetailScreenScrollView contentContainerClassName="grow justify-center gap-4 px-5">
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
  const detail = getKiloPassDetailState({
    subscription: stateQuery.data?.subscription,
    isError: stateQuery.isError,
    isPending: stateQuery.isPending,
  });
  const { t } = useTranslation();

  if (detail.kind === 'loading') {
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
  return <KiloPassDetailBody detail={detail} />;
}
