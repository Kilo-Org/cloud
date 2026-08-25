import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Linking, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/kiloclaw/bot-avatar';
import { Text } from '@/components/ui/text';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { NOTIFICATION_PROMPT_SEEN_KEY } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

type NotificationsStepProps = {
  onComplete: () => void;
  botIdentity: BotIdentity | null;
};

export function NotificationsStep({ onComplete, botIdentity }: Readonly<NotificationsStepProps>) {
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const { isActive } = useAppLifecycle();
  const [permission, setPermission] = useState<'checking' | 'undetermined' | 'denied'>('checking');
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const botName = botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const botEmoji = botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;

  // No onError toast here: registration failures are surfaced inline (see
  // `registerError` below) since this step stays open on failure — the
  // wizard modal's toasts are otherwise invisible/redundant here (see
  // `onboarding-flow.tsx`'s removed generic-error toast for the same reason).
  const registerToken = useMutation(trpc.user.registerPushToken.mutationOptions());
  const registerTokenMutateAsync = registerToken.mutateAsync;

  // Requests (or re-confirms) the push token and registers it with the
  // server, then marks the prompt as seen and advances. Used by both the
  // auto-check effect (permission already granted) and the Enable button.
  // Never leaves the user stranded: any failure — permission request,
  // token fetch, or server registration — lands in `registerError` with a
  // Try again / Skip escape hatch, instead of throwing silently.
  const completeRegistration = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      setRegisterError(null);
      setIsRegistering(true);
      try {
        const token = await registerForPushNotifications();
        if (isCancelled()) {
          return;
        }
        if (token) {
          await registerTokenMutateAsync({
            token,
            platform: getPlatform(),
            // Both fields are read per token when a push is sent: a null
            // locale sends English copy, and a null app_version drops the
            // Android channel id. Omitting them here writes nulls over the
            // values an earlier registration stored.
            appVersion: Application.nativeApplicationVersion ?? undefined,
            locale: getResolvedLanguage(),
          });
          if (isCancelled()) {
            return;
          }
        }
        await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
        if (isCancelled()) {
          return;
        }
        onComplete();
      } catch (error) {
        if (isCancelled()) {
          return;
        }
        setRegisterError(
          error instanceof Error
            ? error.message
            : t('kiloclaw.onboarding.notifications.couldNotEnable')
        );
      } finally {
        if (!isCancelled()) {
          setIsRegistering(false);
        }
      }
    },
    [onComplete, registerTokenMutateAsync, t]
  );

  // Re-check permission on mount and whenever the app returns to foreground.
  // The user may have flipped the setting via the system Settings app after
  // we deep-linked them there; picking that up on resume avoids stranding
  // them on the "denied" state view.
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      const permStatus = await getNotificationPermissionStatus();
      if (cancelled) {
        return;
      }
      if (permStatus === 'granted') {
        await completeRegistration(() => cancelled);
      } else {
        setPermission(permStatus);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [isActive, completeRegistration]);

  const handleEnable = useCallback(async () => {
    const currentStatus = await getNotificationPermissionStatus();

    if (currentStatus === 'denied') {
      Alert.alert(t('notifications.disabledTitle'), t('notifications.disabledMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.openSettings'), onPress: () => void Linking.openSettings() },
      ]);
      return;
    }

    await completeRegistration();
  }, [completeRegistration, t]);

  const handleSkip = useCallback(async () => {
    try {
      await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
    } catch {
      // Skip is an explicit user choice to move on — never block it on a
      // storage write failing.
    } finally {
      onComplete();
    }
  }, [onComplete]);

  if (permission === 'checking' || isRegistering) {
    return (
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <ActivityIndicator size="small" color={colors.mutedForeground} />
        <Text variant="muted" className="text-center text-sm">
          {t('kiloclaw.onboarding.notifications.settingUp')}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 gap-6"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-2">
        <Text variant="eyebrow" className="text-xs">
          {t('notifications.title')}
        </Text>
        <Text className="text-2xl font-semibold">
          {t('kiloclaw.onboarding.notifications.stayInTheLoop')}
        </Text>
        <Text variant="muted" className="text-base">
          {t('kiloclaw.onboarding.notifications.getNotified', { name: botName })}
        </Text>
      </View>

      <View className="rounded-2xl border border-border bg-card p-4">
        <View className="flex-row items-start gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-neutral-200 dark:bg-neutral-800">
            <BotAvatar emoji={botEmoji} size={20} color={colors.foreground} />
          </View>
          <View className="flex-1 gap-1">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold">{botName}</Text>
              <Text className="text-xs text-muted-foreground">
                {t('kiloclaw.onboarding.notifications.now')}
              </Text>
            </View>
            <Text className="text-sm text-muted-foreground" numberOfLines={2}>
              {t('kiloclaw.onboarding.notifications.mockMessage')}
            </Text>
          </View>
        </View>
      </View>

      {registerError ? <Text className="text-sm text-destructive">{registerError}</Text> : null}

      <View className="gap-3">
        <Button size="lg" onPress={() => void handleEnable()}>
          <Text className="text-base">
            {registerError ? t('common.tryAgain') : t('notifications.enable')}
          </Text>
          <DirectionalChevronRight size={16} color={colors.primaryForeground} />
        </Button>
        <Button variant="ghost" size="lg" onPress={() => void handleSkip()}>
          <Text className="text-base">{t('kiloclaw.onboarding.notifications.skipForNow')}</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
