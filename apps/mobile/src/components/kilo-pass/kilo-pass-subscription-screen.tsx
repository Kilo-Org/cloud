import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { CenteredState } from '@/components/centered-state';
import { StateSurface } from '@/components/centered-state-surface';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Crown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { useTRPC } from '@/lib/trpc';
import {
  KILO_PASS_TITLE,
  type PurchasePresentationKind,
  type PurchaseStatusClass,
} from '@kilocode/app-shared/commerce';

function KiloPassLoadingScreen() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Skeleton className="h-4 w-64 rounded" />
          {[0, 1, 2].map(index => (
            <Skeleton key={index} className="h-[112px] w-full rounded-xl" />
          ))}
        </DetailScreenScrollView>
      </View>
    </View>
  );
}

function KiloPassPresentationErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
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
    </View>
  );
}

type PresentationProps = {
  presentation: {
    kind: PurchasePresentationKind;
    statusClass: PurchaseStatusClass;
    webUrl: string | null;
  };
};

/**
 * Shows the server presentation: web management opens the web console, and the
 * non-retryable unavailable kind is a finished state with its own way out.
 */
function KiloPassUnavailableScreen({ presentation }: PresentationProps) {
  const { t } = useTranslation();
  const router = useRouter();

  if (presentation.kind === 'unavailable') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloPass.title')} modal />
        {/* The body publishes its own band. Without it the centered state
            starts at the whole window's centre and lifts by half the header
            when its measured frame arrives. */}
        <StateSurface className="flex-1">
          <EmptyState
            icon={Crown}
            title={t('kiloPass.purchaseUnavailableTitle')}
            // Only a pass the server reports as ended has something the title does
            // not say; the plain kind would restate the title, which the state's
            // own guide forbids.
            description={
              presentation.statusClass === 'terminal'
                ? t('kiloPass.purchaseUnavailableEnded')
                : undefined
            }
            action={
              <Button
                accessibilityLabel={t('credits.title')}
                className={STATE_ACTION_CLASS}
                onPress={() => {
                  // Replacing the dead-end modal keeps one sheet on screen.
                  router.replace('/(app)/credits' as Href);
                }}
                variant="outline"
              >
                <Text>{t('credits.title')}</Text>
              </Button>
            }
          />
        </StateSurface>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <CenteredState>
        <View className="items-center gap-3 px-6">
          <Text className="text-center text-sm leading-[1.25rem] text-muted-foreground">
            {t('kiloPass.subscriptionHeaderDescription')}
          </Text>
          <Text className="text-center font-semibold text-foreground">{KILO_PASS_TITLE}</Text>
          <Text className="text-center text-sm text-muted-foreground">
            {t('kiloPass.managedOnWeb')}
          </Text>
          {presentation.webUrl ? (
            // The lone centered CTA: 48dp keeps the whole pressable above the
            // Android minimum without hitSlop, since nothing sits beside it.
            <Button
              accessibilityLabel={t('kiloPass.manage')}
              className="min-h-[48px]"
              onPress={() => {
                if (!presentation.webUrl) {
                  return;
                }
                void openExternalUrl(presentation.webUrl, {
                  label: t('kiloPass.kiloPassManagement'),
                });
              }}
              variant="outline"
            >
              <Text>{t('kiloPass.manage')}</Text>
            </Button>
          ) : null}
        </View>
      </CenteredState>
    </View>
  );
}

export function KiloPassSubscriptionScreen() {
  const trpc = useTRPC();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
  const presentationQuery = useQuery(
    trpc.kiloPass.getPurchasePresentation.queryOptions({
      platform,
      storefront,
      product: 'kilo_pass',
    })
  );

  if (presentationQuery.isPending) {
    return <KiloPassLoadingScreen />;
  }
  if (!presentationQuery.data) {
    return (
      <KiloPassPresentationErrorScreen
        onRetry={() => {
          void presentationQuery.refetch();
        }}
      />
    );
  }
  return <KiloPassUnavailableScreen presentation={presentationQuery.data} />;
}
