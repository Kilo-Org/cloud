import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { Section } from '@/components/consent/section';
import { type ConsentMode } from '@/components/consent/consent-mode';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PRIVACY_URL } from '@/lib/config';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { voiceInputController } from '@/lib/voice-input/native-voice-input';
import {
  readVoiceNetworkConsent,
  subscribeToVoiceNetworkConsent,
  type VoiceNetworkConsent,
  writeVoiceNetworkConsent,
} from '@/lib/voice-input/voice-network-consent';

type ConsentDetailsProps = {
  readonly mode?: ConsentMode;
};

export function VoiceTranscriptionControl() {
  const { userId, isLoading, isError, refetch } = useCurrentUserId();
  const supportsOnDevice = voiceInputController.supportsOnDevice();
  const [consent, setConsent] = useState<VoiceNetworkConsent>('unset');
  const { t } = useTranslation();

  useEffect(() => {
    if (!userId) {
      setConsent('unset');
      return undefined;
    }
    let active = true;
    void (async () => {
      const value = await readVoiceNetworkConsent(userId);
      // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- active is cleared on unmount
      if (active) {
        setConsent(value);
      }
    })();
    const unsubscribe = subscribeToVoiceNetworkConsent((changedUserId, value) => {
      if (changedUserId === userId) {
        setConsent(value);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId]);

  if (supportsOnDevice) {
    return <Text className="mt-3 text-sm text-muted-foreground">{t('consent.onDevice')}</Text>;
  }

  if (isLoading) {
    return <Text className="mt-3 text-sm text-muted-foreground">{t('consent.loading')}</Text>;
  }

  if (isError) {
    return (
      <View className="mt-3 gap-2">
        <Text className="text-sm text-muted-foreground">
          {t('consent.couldNotLoadTranscription')}
        </Text>
        <Button variant="outline" onPress={refetch} accessibilityLabel={t('common.retry')}>
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }

  // No non-retryable unhappy state exists: `readVoiceNetworkConsent` never
  // fails (an absent or corrupt value reads as 'unset'), and the control has no
  // terminal failure mode — a write failure is always retryable.
  if (!userId) {
    return (
      <Text className="mt-3 text-sm text-muted-foreground">
        {t('consent.signInToManageTranscription')}
      </Text>
    );
  }

  const allowed = consent === 'granted';
  const label = allowed ? t('consent.onlineAllowed') : t('consent.onlineNotAllowed');

  const handleToggle = async (next: boolean) => {
    const value: 'granted' | 'declined' = next ? 'granted' : 'declined';
    const previous = consent;
    setConsent(value);
    try {
      await writeVoiceNetworkConsent(userId, value);
    } catch {
      // Roll back the optimistic flip so the switch reflects the stored value.
      setConsent(previous);
      toast.error(t('consent.couldNotSaveChoice'));
    }
  };

  return (
    <View className="mt-3 flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-sm text-muted-foreground">{label}</Text>
      <Switch
        value={allowed}
        onValueChange={handleToggle}
        accessibilityLabel={t('consent.onlineTranscription')}
      />
    </View>
  );
}

export function ConsentDetails({ mode = 'onboarding' }: ConsentDetailsProps) {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const contentContainerStyle = {
    paddingTop: 8,
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };

  const handleOpenPrivacy = () => {
    void WebBrowser.openBrowserAsync(PRIVACY_URL);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('consent.title')} />
      <ScrollView
        className="flex-1 px-6"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <Section
          title={t('consent.aiProvidersTitle')}
          what={t('consent.aiProvidersWhat')}
          why={t('consent.aiProvidersWhy')}
          who={t('consent.aiProvidersWho')}
        />
        <Section
          title={t('consent.gatewayTitle')}
          what={t('consent.gatewayWhat')}
          why={t('consent.gatewayWhy')}
          who={t('consent.gatewayWho')}
        />
        <Section
          title={t('consent.crashReportingTitle')}
          what={t('consent.crashReportingWhat')}
          why={t('consent.crashReportingWhy')}
          who={t('consent.crashReportingWho')}
          footer={
            <View className="mt-3 gap-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">{t('consent.crashReportingNote')}</Text>
              </View>
            </View>
          }
        />

        <Text className="mt-6 text-sm font-semibold text-foreground">
          {mode === 'review' ? t('consent.optionalReview') : t('consent.optionalOnboarding')}
        </Text>

        <Section
          title={t('consent.productAnalyticsTitle')}
          what={t('consent.productAnalyticsWhat')}
          why={t('consent.productAnalyticsWhy')}
          who={t('consent.productAnalyticsWho')}
          footer={
            <View className="mt-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">{t('consent.productAnalyticsNote')}</Text>
              </View>
            </View>
          }
        />
        <Section
          title={t('consent.errorScreenshotsTitle')}
          what={t('consent.errorScreenshotsWhat')}
          why={t('consent.errorScreenshotsWhy')}
          who={t('consent.errorScreenshotsWho')}
          footer={
            <View className="mt-3">
              <View className="rounded-md bg-warn-tile-bg p-3">
                <Text className="text-xs text-warn">{t('consent.errorScreenshotsNote')}</Text>
              </View>
            </View>
          }
        />
        <Section
          title={t('consent.installAttributionTitle')}
          what={t('consent.installAttributionWhat')}
          why={t('consent.installAttributionWhy')}
          who={t('consent.installAttributionWho')}
        />
        <Section
          title={t('consent.voiceTranscriptionTitle')}
          what={t('consent.voiceTranscriptionWhat')}
          why={t('consent.voiceTranscriptionWhy')}
          who={t('consent.voiceTranscriptionWho')}
          footer={<VoiceTranscriptionControl />}
        />

        <Text className="mt-6 text-xs text-muted-foreground">
          {t('consent.retentionPrefix')}{' '}
          <Text className="text-xs text-primary underline" onPress={handleOpenPrivacy}>
            {t('consent.privacyPolicy')}
          </Text>
          .
        </Text>

        <View className="mt-8">
          <Button
            size="lg"
            onPress={() => {
              router.back();
            }}
            accessibilityLabel={t('consent.backToConsent')}
          >
            <Text>{t('consent.backToConsent')}</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
