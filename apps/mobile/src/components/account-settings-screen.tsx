import { type Href, useRouter } from 'expo-router';
import { Globe, Shield, Smartphone } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { attemptPushRegistrationReconciliation } from '@/lib/auth/push-registration-reconciliation';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';

/**
 * Account settings subpage. Rows are moved verbatim from the former
 * PreferencesScreen (slice s1 is a move only, no behavior change): every label,
 * subtitle, disabled condition, default, and effect is unchanged.
 */
export function AccountSettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { userId } = useCurrentUserId();
  const { preference: languagePreference } = useLanguagePreference();
  const { hasLoaded: trustedHostsLoaded } = useTrustedHosts();
  const languageEndonym = LANGUAGE_ENDONYMS[getResolvedLanguage()];
  const languageSubtitle =
    languagePreference === 'device'
      ? `${t('common.device')} · ${languageEndonym}`
      : languageEndonym;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.account')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <ConfigureRow
          icon={Globe}
          title={t('common.language')}
          subtitle={languageSubtitle}
          className="rounded-lg bg-secondary px-3"
          onPress={() => {
            setLanguagePickerBridge({
              onApplied: () => {
                if (userId) {
                  void attemptPushRegistrationReconciliation(userId);
                }
              },
            });
            router.push('/(app)/language-picker' as Href);
          }}
        />
        <ConfigureRow
          icon={Shield}
          title={t('trustedHosts.title')}
          subtitle={t('trustedHosts.subtitle')}
          className="rounded-lg bg-secondary px-3"
          disabled={!trustedHostsLoaded}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/trusted-hosts' as Href);
          }}
        />
        <ConfigureRow
          icon={Smartphone}
          title={t('common.deviceSessions')}
          subtitle={t('profile.deviceSessionsSubtitle')}
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push('/(app)/device-sessions' as Href);
          }}
        />
      </TabScreenScrollView>
    </View>
  );
}
