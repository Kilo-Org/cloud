import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { Section } from '@/components/consent/section';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PRIVACY_URL } from '@/lib/config';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { useGatewayTranscriptionPreference } from '@/lib/voice-input/gateway/gateway-transcription-preference';
import { voiceInputController } from '@/lib/voice-input/native-voice-input';
import {
  useVoiceInputLanguage,
  useVoiceInputLanguageLoaded,
} from '@/lib/voice-input/voice-input-language-preference';
import {
  isVoiceInputLanguageInstalledOnDevice,
  resolveVoiceInputSessionLanguageTag,
} from '@/lib/voice-input/voice-input-language';
import { resolveVoiceTranscriptionReviewMode } from '@/lib/voice-input/voice-input-recognition-mode';
import {
  readVoiceNetworkConsent,
  subscribeToVoiceNetworkConsent,
  type VoiceNetworkConsent,
  writeVoiceNetworkConsent,
} from '@/lib/voice-input/voice-network-consent';

export function VoiceTranscriptionControl() {
  const { userId, isLoading, isFetchError, refetch } = useCurrentUserId();
  const { gatewayTranscriptionEnabled, hasLoaded } = useGatewayTranscriptionPreference();
  const supportsOnDevice = voiceInputController.supportsOnDevice();
  const [consent, setConsent] = useState<VoiceNetworkConsent>('unset');
  const storedLanguageTag = useVoiceInputLanguage();
  // The stored tag is the SecureStore default (`null`) until the module-scope
  // read settles, which can take seconds on a slow keychain read; deriving the
  // session tag from the app language in that window would claim a mode for a
  // choice that may exist (voice-input-settings-screen.tsx gates this exact
  // read the same way). Keep the row on the loading placeholder until it lands.
  const languageLoaded = useVoiceInputLanguageLoaded();
  const { t, i18n } = useTranslation();

  // The mic refines the service-level on-device check with the offline model
  // of the language a dictation would actually use (use-voice-input-actions.ts):
  // a device whose service supports on-device recognition but lacks the model
  // for the resolved language raises the online disclosure on every start, so
  // this row must not claim "On device" there. Resolve the same session tag
  // the mic does, then run the same installed-model gate, and re-derive when
  // the stored choice or the app language changes. The gate never errors:
  // `isVoiceInputLanguageInstalledOnDevice` treats a failed probe as
  // installed, matching the mic's fail-open start path. `null` is the pending
  // gate; the sync modes (gateway on, no service support) branch before it.
  const [languageInstalled, setLanguageInstalled] = useState<boolean | null>(null);
  const appLanguage = i18n.language;

  useEffect(() => {
    if (gatewayTranscriptionEnabled || !supportsOnDevice || !languageLoaded) {
      return undefined;
    }
    let active = true;
    setLanguageInstalled(null);
    void (async () => {
      const languageTag = await resolveVoiceInputSessionLanguageTag(
        storedLanguageTag,
        'device',
        appLanguage
      );
      const installed = await isVoiceInputLanguageInstalledOnDevice(languageTag);
      // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- active is cleared on unmount
      if (active) {
        setLanguageInstalled(installed);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    gatewayTranscriptionEnabled,
    supportsOnDevice,
    languageLoaded,
    storedLanguageTag,
    appLanguage,
  ]);

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

  // The gateway preference owns the whole session while it is on, so it is
  // named before any on-device claim: a device that supports on-device
  // recognition still sends every dictation to the gateway when the switch is
  // on (voice-input-engine-mode.ts), and printing "On device" there was wrong.
  //
  // The account read gates every claim the row makes, so its loading and error
  // states come before the gateway and on-device branches: a device that
  // supports on-device recognition used to print "On device" while the account
  // read had failed, so the retryable error branch never surfaced on it (vr1
  // e1 device repro, 2026-09-15). `isFetchError` (not `isError`) is the gate:
  // a failed refetch keeps the cached identity, and presenting that cached
  // destination as the current one is exactly the state this branch exists to
  // avoid. One loading branch covers both reads so the row never stacks two
  // indicators.
  if (!hasLoaded || isLoading) {
    // A SecureStore or account read is still pending; do not claim a state
    // that has not been read yet.
    return <Text className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</Text>;
  }

  if (isFetchError) {
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

  // The mode gate owns the on-device claim: the review never prints "On
  // device" from the service-level support alone — the mic refines that check
  // with the offline model of the resolved language, and a device without the
  // model raises the online disclosure on every start. `languageInstalled`
  // stays `null` while that per-language gate is pending; the row shows the
  // loading placeholder instead of a state it has not read (same rule as the
  // account read). Devices without service support skip the gate entirely and
  // fall through to the online consent row.
  const reviewMode = resolveVoiceTranscriptionReviewMode({
    gatewayTranscriptionEnabled,
    serviceSupportsOnDevice: supportsOnDevice,
    languageInstalledOnDevice: languageInstalled === true,
  });

  if (reviewMode === 'gateway') {
    // Status row only: the engine is chosen in Preferences, so this row carries
    // no switch — matching the on-device row below.
    return (
      <View className="mt-3 flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-muted-foreground">
          {t('consent.voiceTranscriptionTitle')}
        </Text>
        <Text className="text-sm font-medium text-foreground">{t('consent.viaGateway')}</Text>
      </View>
    );
  }

  if (supportsOnDevice && languageInstalled === null) {
    return <Text className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</Text>;
  }

  if (reviewMode === 'on-device') {
    // Status row in the toggle row's geometry (label left, value right) so it
    // reads as the transcription state, not a stray fragment under the Who
    // line (e4 spot check, 2026-09-07). The label is the neutral section
    // name: "Online transcription → On device" contradicted itself (vr1
    // review, 2026-09-07). On-device is always used when supported, so there
    // is no online choice to offer.
    return (
      <View className="mt-3 flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-muted-foreground">
          {t('consent.voiceTranscriptionTitle')}
        </Text>
        <Text className="text-sm font-medium text-foreground">{t('consent.onDevice')}</Text>
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
    const stored = await writeVoiceNetworkConsent(userId, value);
    if (!stored) {
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

export function ConsentDetails() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const sideInsetStyle = useSideInsetStyle();
  const { t } = useTranslation();
  const contentContainerStyle = {
    ...sideInsetStyle,
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
        className="flex-1"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-6">
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
            {t('consent.optionalChangeAnytime')}
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
            who={t('consent.crashReportingWho')}
            footer={
              <View className="mt-3">
                <View className="rounded-md bg-warn-tile-bg p-3">
                  <Text className="text-xs text-warn">{t('consent.errorScreenshotsNote')}</Text>
                </View>
              </View>
            }
          />
          <Section
            title={t('consent.performanceProfilingTitle')}
            what={t('consent.performanceProfilingWhat')}
            why={t('consent.performanceProfilingWhy')}
            who={t('consent.crashReportingWho')}
            footer={
              <View className="mt-3">
                <View className="rounded-md bg-warn-tile-bg p-3">
                  <Text className="text-xs text-warn">{t('consent.performanceProfilingNote')}</Text>
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
        </View>
      </ScrollView>
    </View>
  );
}
