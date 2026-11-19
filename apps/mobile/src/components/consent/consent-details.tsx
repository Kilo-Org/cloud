import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentPolicySentence } from '@/components/consent/consent-policy-sentence';
import { Section } from '@/components/consent/section';
import { type ConsentMode } from '@/components/consent/consent-mode';
import { VoiceTranscriptionControl } from '@/components/consent/voice-transcription-control';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';

type ConsentDetailsProps = {
  readonly mode?: ConsentMode;
};

export function ConsentDetails({ mode = 'onboarding' }: ConsentDetailsProps) {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const sideInsetStyle = useSideInsetStyle();
  const { t } = useTranslation();
  const contentContainerStyle = {
    ...sideInsetStyle,
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };

  const handleOpenPrivacy = () => {
    router.push({ pathname: '/(app)/legal/[document]', params: { document: 'privacy' } });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('consent.title')} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View className={SCREEN_BODY_CLASS}>
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

          <Section
            title={t('consent.featureFlagsTitle')}
            what={t('consent.featureFlagsWhat')}
            why={t('consent.featureFlagsWhy')}
            who={t('consent.featureFlagsWho')}
          />

          <SectionHeader
            label={
              mode === 'review' ? t('consent.optionalReview') : t('consent.optionalOnboarding')
            }
          />

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

          <View className="mt-6">
            <ConsentPolicySentence
              prefix={t('consent.retentionPrefix')}
              linkLabel={t('consent.privacyPolicy')}
              onOpenPolicy={handleOpenPrivacy}
            />
          </View>

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
