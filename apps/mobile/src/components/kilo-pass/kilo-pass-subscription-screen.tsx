import { type Href, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { CenteredState } from '@/components/centered-state';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Crown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { useTRPC } from '@/lib/trpc';
import {
  KILO_PASS_TITLE,
  type PurchasePresentationKind,
  type PurchaseStatusClass,
} from '@kilocode/app-shared/commerce';

/**
 * The screen's frame: one header for every presentation kind, above the body it
 * owns. The route presents as a full-screen modal on Android, so the sheet edge
 * reaches the window top there and this frame clears the status-bar inset
 * itself; the iOS page sheet presents below the status bar, reserves nothing,
 * and the header keeps its own grabber clearance.
 */
function KiloPassFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const windowTopClearance = useSheetHeaderTopClearance('android-window-top');
  const surfaceOwnsWindowTop = windowTopClearance > 0;
  return (
    <View className="flex-1 bg-background">
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
    </KiloPassFrame>
  );
}

function KiloPassPresentationErrorScreen({ onRetry }: { onRetry: () => void }) {
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
    // The ended fact plus the unavailability sentence. Each catalog holds its own
    // sentence once, so the two compose here rather than one spelling the other;
    // they already carry their terminal punctuation, so the separator is a space
    // and not the locale's `sentenceJoiner`, which would add a second period.
    const description =
      presentation.statusClass === 'terminal'
        ? [t('kiloPass.purchaseUnavailableEnded'), t('kiloPass.purchaseUnavailable')].join(' ')
        : undefined;
    return (
      <KiloPassFrame>
        {/* This screen owns the body below the header, so the state centres in
            it directly. The measured placement would start at the window's
            centre and lift by half the header, a jump on every open. */}
        <View className="flex-1 justify-center">
          <EmptyState
            placement="static"
            icon={Crown}
            title={t('kiloPass.purchaseUnavailableTitle')}
            // The plain kind has nothing the title does not say, and the state's
            // own guide forbids a description that restates it.
            description={description}
            action={
              <Button
                accessibilityLabel={t('credits.title')}
                className={STATE_ACTION_CLASS}
                onPress={() => {
                  // Replacing the dead-end modal keeps one sheet on screen.
                  router.replace('/(app)/credits' as Href);
                }}
              >
                <Text>{t('credits.title')}</Text>
              </Button>
            }
          />
        </View>
      </KiloPassFrame>
    );
  }

  return (
    <KiloPassFrame>
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
    </KiloPassFrame>
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
