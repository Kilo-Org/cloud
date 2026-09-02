import { type ComponentProps, type ReactElement } from 'react';
import { Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CenteredState } from '@/components/centered-state';
import { NativeStateSurface, StateSurface } from '@/components/centered-state-surface';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { cn } from '@/lib/utils';

type UnlockOutcome = ReturnType<typeof useAppUnlock>['outcome'];

function unlockFeedbackKey(outcome: UnlockOutcome) {
  if (outcome?.status === 'setup-required') {
    return 'bootstrap.couldNotLoadPrivacyDescription';
  }
  if (outcome?.status === 'save-failed') {
    return 'common.couldNotSaveSetting';
  }
  if (outcome?.status === 'failed' || outcome?.status === 'lockout') {
    return 'common.somethingWentWrong';
  }
  return null;
}

/** One owner announces shared outcomes, including setting failures behind a locked scene. */
export function AppUnlockAnnouncements() {
  const { status, outcome } = useAppUnlock();
  const { t } = useTranslation();
  const key =
    status === 'preference-error' ? 'common.somethingWentWrong' : unlockFeedbackKey(outcome);
  useStatusAnnouncement(key === null ? null : t(key));
  return null;
}

// Keep native live regions in each scene; hidden scenes must not issue imperative iOS speech.
function UnlockStatusText({ message }: Readonly<{ message: string | null }>) {
  if (message === null) {
    return null;
  }
  return (
    <Text
      accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
      className="text-sm text-destructive"
    >
      {message}
    </Text>
  );
}

export function AppUnlockFeedback({ outcome }: Readonly<{ outcome: UnlockOutcome }>) {
  const { t } = useTranslation();
  const key = unlockFeedbackKey(outcome);
  const feedback = <UnlockStatusText message={key === null ? null : t(key)} />;
  if (outcome?.status === 'setup-required') {
    return (
      <View className="gap-1">
        <Text className="text-sm font-medium">{t('agentChat.modelSelector.unavailable')}</Text>
        {feedback}
      </View>
    );
  }
  return feedback;
}

function contentPadding({ left, right }: EdgeInsets) {
  return { paddingLeft: left + 24, paddingRight: right + 24 };
}

function AppUnlockScene({ children }: Readonly<{ children: ReactElement }>) {
  const { status, busy, outcome, retry } = useAppUnlock();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hidden = status !== 'unlocked';

  // Keep the unlocked wrapper layout-only so native sheet headers and scroll views
  // remain siblings at indices 0 and 1. Never replace the mounted scene to hide it.
  return (
    <>
      <View
        className={cn('flex-1', hidden && 'opacity-0')}
        pointerEvents={hidden ? 'none' : 'auto'}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {hidden ? (
        <StateSurface className="absolute inset-0 bg-background" accessibilityViewIsModal>
          <CenteredState>
            <View className="w-full gap-8" style={contentPadding(insets)}>
              <View className="gap-3">
                <Text accessibilityRole="header" className="text-center text-xl font-semibold">
                  {t('preferences.biometricUnlock')}
                </Text>
                <UnlockStatusText
                  message={status === 'preference-error' ? t('common.somethingWentWrong') : null}
                />
                <AppUnlockFeedback outcome={outcome} />
              </View>
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
            </View>
          </CenteredState>
        </StateSurface>
      ) : null}
    </>
  );
}

/** Presentation only: one provider owns authentication across every native Stack scene. */
export function appUnlockScreenLayout({
  children,
  ...props
}: ComponentProps<typeof NativeStateSurface>): ReactElement {
  return (
    <NativeStateSurface {...props}>
      <AppUnlockScene>{children}</AppUnlockScene>
    </NativeStateSurface>
  );
}
