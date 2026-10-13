import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { CenteredState } from '@/components/centered-state';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useTRPC } from '@/lib/trpc';
import { KILO_PASS_TITLE, type PurchasePresentationKind } from '@kilocode/app-shared/commerce';

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

/** Shows the server presentation and opens web management when available. */
function KiloPassUnavailableScreen({
  presentation,
}: {
  presentation: { kind: PurchasePresentationKind; webUrl: string | null };
}) {
  const { t } = useTranslation();
  const isWebManagement = presentation.kind === 'web_management';
  const description = isWebManagement
    ? t('kiloPass.managedOnWeb')
    : t('kiloPass.purchaseUnavailable');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <CenteredState>
        <View className="items-center gap-3 px-6">
          <Text className="text-center text-sm leading-5 text-muted-foreground">
            {t('kiloPass.subscriptionHeaderDescription')}
          </Text>
          <Text className="text-center font-semibold text-foreground">{KILO_PASS_TITLE}</Text>
          <Text className="text-center text-sm text-muted-foreground">{description}</Text>
          {isWebManagement && presentation.webUrl ? (
            <Button
              accessibilityLabel={t('kiloPass.manage')}
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
              {t('kiloPass.manage')}
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
