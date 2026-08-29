import { type ReactElement } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { cn } from '@/lib/utils';

export function AppUnlockFeedback({
  outcome,
}: {
  readonly outcome: ReturnType<typeof useAppUnlock>['outcome'];
}) {
  const { t } = useTranslation();
  if (outcome?.status === 'setup-required') {
    return (
      <View className="gap-1">
        <Text className="text-sm font-medium">{t('agentChat.modelSelector.unavailable')}</Text>
        <AccessibleStatus
          message={t('bootstrap.couldNotLoadPrivacyDescription')}
          className="text-sm"
        />
      </View>
    );
  }
  let message: string | null = null;
  if (outcome?.status === 'save-failed') {
    message = t('common.couldNotSaveSetting');
  } else if (outcome?.status === 'failed' || outcome?.status === 'lockout') {
    message = t('common.somethingWentWrong');
  }
  return <AccessibleStatus message={message} className="text-sm" />;
}

function contentPadding({ top, bottom, left, right }: EdgeInsets) {
  return {
    paddingTop: top + 24,
    paddingBottom: bottom + 24,
    paddingLeft: left + 24,
    paddingRight: right + 24,
  };
}

function AppUnlockScene({ children }: Readonly<{ children: ReactElement }>) {
  const { status, busy, outcome, retry } = useAppUnlock();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hidden = status !== 'unlocked';

  return (
    <View className="flex-1 bg-background">
      <View
        className={cn('flex-1', hidden && 'opacity-0')}
        pointerEvents={hidden ? 'none' : 'auto'}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {hidden ? (
        <View className="absolute inset-0 bg-background" accessibilityViewIsModal>
          <ScrollView
            className="flex-1"
            contentContainerClassName="grow justify-center gap-4"
            contentContainerStyle={contentPadding(insets)}
          >
            <Text accessibilityRole="header" className="text-center text-xl font-semibold">
              {t('preferences.biometricUnlock')}
            </Text>
            <AccessibleStatus
              message={status === 'preference-error' ? t('common.somethingWentWrong') : null}
              className="text-sm"
            />
            <AppUnlockFeedback outcome={outcome} />
            {status === 'preference-loading' ? (
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={t('preferences.biometricUnlock')}
                accessibilityState={{ busy: true }}
              >
                <Skeleton className="h-11 w-full rounded-md" />
              </View>
            ) : (
              <Button onPress={retry} loading={busy} accessibilityLabel={t('common.retry')}>
                <Text>{t('common.retry')}</Text>
              </Button>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** Presentation only: one provider owns authentication across every native Stack scene. */
export function appUnlockScreenLayout({
  children,
}: Readonly<{ children: ReactElement }>): ReactElement {
  return <AppUnlockScene>{children}</AppUnlockScene>;
}
