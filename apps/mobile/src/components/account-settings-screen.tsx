import { useMutation } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import {
  Ban,
  Cpu,
  FileText,
  Flag,
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
import {
  SettingsSearchScrollView,
  SettingsTarget,
} from '@/components/settings-search/settings-target';
import { ConfigureRow } from '@/components/ui/configure-row';
import { DirectionalLogOut } from '@/components/ui/directional-icons';
import { useConfirmDialog } from '@/components/ui/dialog';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { attemptPushRegistrationReconciliation } from '@/lib/auth/push-registration-reconciliation';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';
import { ACCOUNT_SETTINGS } from '@/lib/settings-search/preference-sources';

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
export function AccountSettingsScreen({ settingsTarget }: Readonly<{ settingsTarget?: string }>) {
  const router = useRouter();
  const pushOnce = useSinglePushRoute();
  // A pushed child screen returns focus here, so the press that closed it must
  // not open the row that lands under the second tap of the burst.
  const { guard } = useSheetRowTapGuard();
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

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <RowGroup leadingTile>
        {SKELETON_ROWS.map(row => (
          <RowSkeleton key={row} tile subtitle />
        ))}
      </RowGroup>
    );
  } else if (isFetchError) {
    // A failed attempt keeps a cached identity, which must not be presented as
    // the current account's settings, so the retry stands in place of the rows.
    body = <QueryError onRetry={refetch} />;
  } else {
    body = (
      <RowGroup leadingTile>
        <SettingsTarget item={ACCOUNT_SETTINGS.profile}>
          <ConfigureRow
            icon={UserRound}
            title={t(ACCOUNT_SETTINGS.profile.label)}
            subtitle={t('profile.editProfile.rowSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/profile-edit' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.signInMethods}>
          <ConfigureRow
            icon={Lock}
            title={t(ACCOUNT_SETTINGS.signInMethods.label)}
            subtitle={t('profile.linkedAccounts')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/login-methods' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.language}>
          <ConfigureRow
            icon={Globe}
            title={t(ACCOUNT_SETTINGS.language.label)}
            subtitle={languageSubtitle}
            onPress={guard(() => {
              setLanguagePickerBridge({
                onApplied: () => {
                  if (userId) {
                    void attemptPushRegistrationReconciliation(userId);
                  }
                },
              });
              pushOnce('/(app)/language-picker' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.trustedHosts}>
          <ConfigureRow
            icon={Shield}
            title={t(ACCOUNT_SETTINGS.trustedHosts.label)}
            subtitle={t('trustedHosts.subtitle')}
            disabled={!trustedHostsLoaded}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/trusted-hosts' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.passkeys}>
          <ConfigureRow
            icon={KeyRound}
            title={t(ACCOUNT_SETTINGS.passkeys.label)}
            subtitle={t('profile.passkeysSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/passkeys' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.providerKeys}>
          <ConfigureRow
            icon={Cpu}
            title={t(ACCOUNT_SETTINGS.providerKeys.label)}
            subtitle={t('profile.providerKeys.rowSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/provider-keys' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.dataExport}>
          <ConfigureRow
            icon={FileText}
            title={t(ACCOUNT_SETTINGS.dataExport.label)}
            subtitle={t('profile.dataExport.rowSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/data-export' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.blockedPeople}>
          <ConfigureRow
            icon={Ban}
            title={t(ACCOUNT_SETTINGS.blockedPeople.label)}
            subtitle={t('profile.blockedPeople.rowSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/blocked-people' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.reportReceipts}>
          <ConfigureRow
            icon={Flag}
            title={t(ACCOUNT_SETTINGS.reportReceipts.label)}
            subtitle={t('profile.reportReceipts.rowSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/report-receipts' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.deviceSessions}>
          <ConfigureRow
            icon={Smartphone}
            title={t(ACCOUNT_SETTINGS.deviceSessions.label)}
            subtitle={t('profile.deviceSessionsSubtitle')}
            onPress={guard(() => {
              router.push('/(app)/(tabs)/(3_profile)/device-sessions' as Href);
            })}
          />
        </SettingsTarget>
        <SettingsTarget item={ACCOUNT_SETTINGS.browserSignOut}>
          <ConfigureRow
            icon={DirectionalLogOut}
            title={t(ACCOUNT_SETTINGS.browserSignOut.label)}
            subtitle={t('profile.signOutWeb.rowSubtitle')}
            tone="danger"
            accessibilityLabel={t(ACCOUNT_SETTINGS.browserSignOut.label)}
            onPress={guard(() => {
              confirm({
                title: t('profile.signOutWeb.confirmTitle'),
                message: t('profile.signOutWeb.confirmMessage'),
                confirmLabel: t('common.signOut'),
                onConfirm: () => {
                  signOutWeb.mutate(undefined);
                },
              });
            })}
          />
        </SettingsTarget>
      </RowGroup>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.account')} backFallback={PROFILE_TAB_HREF} />
      <SettingsSearchScrollView
        settingsTarget={settingsTarget}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {body}
      </SettingsSearchScrollView>
      {dialog}
    </View>
  );
}
