import { useMutation } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import {
  Ban,
  Cpu,
  FileText,
  Globe,
  KeyRound,
  Lock,
  Shield,
  Smartphone,
  UserRound,
} from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { DirectionalLogOut } from '@/components/ui/directional-icons';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { attemptPushRegistrationReconciliation } from '@/lib/auth/push-registration-reconciliation';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useTRPC } from '@/lib/trpc';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';

/**
 * Rows the skeleton reserves while the account read is pending: enough to fill
 * the first screen of the list, so the swap to real rows does not scroll.
 */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Account settings subpage. The first three rows are unchanged from the former
 * PreferencesScreen (that slice was a move only): every label, subtitle,
 * disabled condition, default, and effect is the same. The rows below them are
 * the account surfaces the web already had: the profile links, the sign-in
 * methods, the caller's provider keys, their data export, the people they hid,
 * and the browser sessions they can revoke.
 */
export function AccountSettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { confirm, dialog } = useConfirmDialog();
  const { userId, isLoading, isFetchError, refetch } = useCurrentUserId();
  const { preference: languagePreference } = useLanguagePreference();
  const { hasLoaded: trustedHostsLoaded } = useTrustedHosts();
  const languageEndonym = LANGUAGE_ENDONYMS[getResolvedLanguage()];
  const languageSubtitle =
    languagePreference === 'device'
      ? `${t('common.device')} · ${languageEndonym}`
      : languageEndonym;

  const signOutWeb = useMutation(
    trpc.user.signOutBrowserSessions.mutationOptions({
      onSuccess: () => announcingToast.success(t('profile.signOutWeb.signedOut')),
      onError: error => toast.error(error.message),
    })
  );

  const rowClassName = 'rounded-lg bg-secondary px-3';

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[54px] rounded-lg" />
        ))}
      </View>
    );
  } else if (isFetchError) {
    // A failed attempt keeps a cached identity, which must not be presented as
    // the current account's settings, so the retry stands in place of the rows.
    body = <QueryError onRetry={refetch} />;
  } else {
    body = (
      <>
        <ConfigureRow
          icon={UserRound}
          title={t('profile.editProfile.title')}
          subtitle={t('profile.editProfile.rowSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/profile-edit' as Href);
          }}
        />
        <ConfigureRow
          icon={Lock}
          title={t('profile.signInMethods.title')}
          subtitle={t('profile.linkedAccounts')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/login-methods' as Href);
          }}
        />
        <ConfigureRow
          icon={Globe}
          title={t('common.language')}
          subtitle={languageSubtitle}
          className={rowClassName}
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
          className={rowClassName}
          disabled={!trustedHostsLoaded}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/trusted-hosts' as Href);
          }}
        />
        <ConfigureRow
          icon={KeyRound}
          title={t('profile.passkeysTitle')}
          subtitle={t('profile.passkeysSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/passkeys' as Href);
          }}
        />
        <ConfigureRow
          icon={Cpu}
          title={t('profile.providerKeys.title')}
          subtitle={t('profile.providerKeys.rowSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/provider-keys' as Href);
          }}
        />
        <ConfigureRow
          icon={FileText}
          title={t('profile.dataExport.title')}
          subtitle={t('profile.dataExport.rowSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/data-export' as Href);
          }}
        />
        <ConfigureRow
          icon={Ban}
          title={t('profile.blockedPeople.title')}
          subtitle={t('profile.blockedPeople.rowSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/blocked-people' as Href);
          }}
        />
        <ConfigureRow
          icon={Smartphone}
          title={t('common.deviceSessions')}
          subtitle={t('profile.deviceSessionsSubtitle')}
          className={rowClassName}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/device-sessions' as Href);
          }}
        />
        <ConfigureRow
          icon={DirectionalLogOut}
          title={t('profile.signOutWeb.title')}
          subtitle={t('profile.signOutWeb.rowSubtitle')}
          tone="danger"
          className={rowClassName}
          last
          accessibilityLabel={t('profile.signOutWeb.title')}
          onPress={() => {
            confirm({
              title: t('profile.signOutWeb.confirmTitle'),
              message: t('profile.signOutWeb.confirmMessage'),
              confirmLabel: t('common.signOut'),
              onConfirm: () => {
                signOutWeb.mutate(undefined);
              },
            });
          }}
        />
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.account')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
