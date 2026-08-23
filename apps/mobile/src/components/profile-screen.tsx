/* eslint-disable max-lines -- The profile screen composes Credits, Agents, Reviews, Organization, Linked accounts, App, Restore Purchases, and Actions; each section is a small rendered surface that mirrors the shared ConfigureRow/Text-header pattern. Splitting would re-encode the same hooks. */
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  GitMerge,
  GitPullRequest,
  Globe,
  KeyRound,
  Lock,
  LogOut,
  MessageSquare,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
} from '@/components/ui/icons';
import { Alert, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { ActionTile } from '@/components/profile-action-tile';
import { CreditsCard } from '@/components/profile-credits-card';
import { LanguagePickerSheet } from '@/components/language-picker-sheet';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useDeleteAccount } from '@/components/use-delete-account';
import { i18n } from '@/i18n';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { useAuth } from '@/lib/auth/auth-context';
import { showFeedbackPrompt } from '@/lib/feedback';
import { useAfterInteractions } from '@/lib/hooks/use-after-interactions';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import {
  getCodeReviewerProfilePath,
  getProfileAgentScope,
  getPrReviewEntryPath,
} from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

const PROVIDER_LABEL_KEYS = {
  anaconda: 'profile.providerAnaconda',
  apple: 'profile.providerApple',
  discord: 'profile.providerDiscord',
  email: 'profile.providerEmail',
  'fake-login': 'profile.providerTestAccount',
  github: 'profile.providerGithub',
  gitlab: 'profile.providerGitlab',
  google: 'profile.providerGoogle',
  linkedin: 'profile.providerLinkedin',
  workos: 'profile.providerEnterpriseSso',
} as const;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function providerLabel(provider: string) {
  const key = lookup(PROVIDER_LABEL_KEYS, provider);
  return key ? i18n.t(key) : provider;
}

export function ProfileScreen() {
  const { signOut, token } = useAuth();
  const router = useRouter();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { organizationId, isLoaded: organizationContextLoaded } = useOrganization();
  const isAuthenticated = token != null;
  const afterInteractions = useAfterInteractions();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const {
    data,
    isLoading,
    isError: providersError,
    isFetching: providersFetching,
    refetch: refetchProviders,
  } = useQuery({
    ...trpc.user.getAuthProviders.queryOptions(),
    enabled: isAuthenticated && afterInteractions,
  });
  const {
    data: orgs,
    isFetching: organizationsFetching,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: isAuthenticated && afterInteractions,
  });
  const agentScope = organizationContextLoaded
    ? getProfileAgentScope(organizationId, orgs, organizationsFetching || !afterInteractions)
    : undefined;
  const selectedOrg = orgs?.find(org => org.organizationId === organizationId);
  const orgRole = selectedOrg?.role;
  const orgName = selectedOrg?.organizationName;

  const { userId } = useCurrentUserId({ enabled: isAuthenticated });

  const { t } = useTranslation();
  const { preference: languagePreference } = useLanguagePreference();
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const resolvedLanguage = getResolvedLanguage();
  const languageEndonym = LANGUAGE_ENDONYMS[resolvedLanguage];
  const languageSubtitle =
    languagePreference === 'device'
      ? `${t('common.device')} · ${languageEndonym}`
      : languageEndonym;

  const {
    phase: deletePhase,
    isPending: deletePending,
    devCode,
    beginDelete,
    submitCode,
    setCode,
  } = useDeleteAccount();

  const confirmDeleteAccount = () => {
    Alert.alert(t('profile.deleteAccountTitle'), t('profile.deleteAccountMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.deleteAccountConfirm'),
        style: 'destructive',
        onPress: beginDelete,
      },
    ]);
  };

  const confirmSignOut = () => {
    Alert.alert(t('profile.signOutTitle'), t('profile.signOutMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.signOutConfirm'),
        style: 'destructive',
        onPress: () => {
          void signOut();
        },
      },
    ]);
  };

  const showPrivacyChoices = () => {
    router.push('/(app)/consent?mode=review' as Href);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.title')} size="large" showBackButton={false} />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Credits */}
        <CreditsCard orgs={orgs} enabled={isAuthenticated} />

        {/* Code Reviewer */}
        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('profile.agents')}
          </Text>
          <ConfigureRow
            icon={GitPullRequest}
            title={t('profile.codeReviewer')}
            subtitle={t('profile.codeReviewerSubtitle')}
            className="rounded-lg bg-secondary px-3"
            disabled={!agentScope}
            onPress={() => {
              if (agentScope) {
                router.push(getCodeReviewerProfilePath(agentScope));
              }
            }}
          />
          <ConfigureRow
            icon={ShieldCheck}
            title={t('profile.securityAgent')}
            subtitle={t('profile.securityAgentSubtitle')}
            className="rounded-lg bg-secondary px-3"
            disabled={!agentScope}
            last
            onPress={() => {
              if (agentScope) {
                router.push(getSecurityAgentPath(agentScope));
              }
            }}
          />
        </View>

        {/* PR Review */}
        {prReviewEnabled && (
          <View className="mt-6 gap-3">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.reviews')}
            </Text>
            <ConfigureRow
              icon={GitMerge}
              title={t('profile.prReview')}
              subtitle={t('profile.prReviewSubtitle')}
              className="rounded-lg bg-secondary px-3"
              last
              onPress={() => {
                router.push(getPrReviewEntryPath());
              }}
            />
          </View>
        )}

        {/* Organization */}
        {organizationId != null && (
          <View className="mt-6 gap-3">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.organization')}
            </Text>
            {organizationsError ? (
              <QueryError
                variant="server"
                placement="top"
                title={t('profile.couldNotLoadOrganization')}
                message={t('profile.couldNotLoadOrganizationDescription')}
                onRetry={() => void refetchOrganizations()}
                isRetrying={organizationsFetching}
              />
            ) : (
              <ConfigureRow
                icon={Building2}
                title={
                  orgRole === 'member'
                    ? t('profile.viewOrganization')
                    : t('profile.manageOrganization')
                }
                subtitle={orgName}
                className="rounded-lg bg-secondary px-3"
                disabled={!orgRole}
                last
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization' as Href);
                }}
              />
            )}
          </View>
        )}

        {/* Linked accounts — hide the whole section when there are no linked
            providers (and we're not loading/erroring) so the header never dangles. */}
        {/* No layout animation on this section: siblings above mount/resize
            asynchronously; LinearTransition would animate this container's
            position lag as a visible header overlap. Opacity fades are safe. */}
        {(providersError ||
          (data?.providers.length ?? 0) > 0 ||
          isLoading ||
          (!afterInteractions && !data)) && (
          <View className="mt-6 gap-3">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.linkedAccounts')}
            </Text>

            {(isLoading || !afterInteractions) && !data && !providersError && (
              <Animated.View exiting={FadeOut.duration(150)}>
                <Skeleton className="h-12 w-full rounded-lg" />
              </Animated.View>
            )}

            {providersError && (
              <QueryError
                variant="server"
                placement="top"
                title={t('profile.couldNotLoadAccounts')}
                onRetry={() => void refetchProviders()}
                isRetrying={providersFetching}
              />
            )}

            {data?.providers.map((p, index) => (
              <Animated.View key={`${p.provider}-${p.email}`} entering={FadeIn.duration(200)}>
                <ConfigureRow
                  icon={KeyRound}
                  title={providerLabel(p.provider)}
                  subtitle={p.email}
                  className="rounded-lg bg-secondary px-3"
                  last={index === data.providers.length - 1}
                />
              </Animated.View>
            ))}
          </View>
        )}

        {/* App */}
        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('profile.app')}
          </Text>
          <ConfigureRow
            icon={SlidersHorizontal}
            title={t('profile.preferences')}
            subtitle={t('profile.preferencesSubtitle')}
            className="rounded-lg bg-secondary px-3"
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/preferences' as Href);
            }}
          />
          <ConfigureRow
            icon={Globe}
            title={t('common.language')}
            subtitle={languageSubtitle}
            className="rounded-lg bg-secondary px-3"
            onPress={() => {
              setLanguagePickerOpen(true);
            }}
          />
          <ConfigureRow
            icon={Smartphone}
            title={t('profile.deviceSessions')}
            subtitle={t('profile.deviceSessionsSubtitle')}
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push('/(app)/device-sessions' as Href);
            }}
          />
        </View>

        {/* Actions — stacked full-width tiles so labels never clip side-by-side at max Dynamic Type */}
        <View className="mt-6 gap-3">
          <ActionTile
            icon={MessageSquare}
            label={t('profile.feedback')}
            color={colors.mutedForeground}
            onPress={() => {
              showFeedbackPrompt(userId);
            }}
          />
          <ActionTile
            icon={Lock}
            label={t('profile.privacyChoices')}
            color={colors.mutedForeground}
            onPress={showPrivacyChoices}
          />
          <ActionTile
            icon={LogOut}
            label={t('profile.signOut')}
            color={colors.mutedForeground}
            onPress={confirmSignOut}
          />
          <ActionTile
            icon={Trash2}
            label={t('profile.deleteAccount')}
            color={colors.destructive}
            destructive
            disabled={deletePending}
            onPress={confirmDeleteAccount}
          />

          {(deletePhase === 'awaiting-code' || deletePhase === 'executing') && (
            <View className="gap-3 rounded-lg bg-secondary p-3">
              <FormField
                label={t('profile.confirmationCode')}
                placeholder={t('profile.confirmationCodePlaceholder')}
                keyboardType="number-pad"
                defaultValue={devCode ?? undefined}
                onChangeText={setCode}
                editable={deletePhase !== 'executing'}
              />
              <Button
                variant="destructive"
                loading={deletePhase === 'executing'}
                disabled={deletePhase === 'executing'}
                onPress={submitCode}
              >
                <Text>{t('profile.confirmDeletion')}</Text>
              </Button>
            </View>
          )}

          <Text className="text-center text-xs text-muted-foreground">
            v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
          </Text>
        </View>
      </TabScreenScrollView>
      <LanguagePickerSheet
        visible={languagePickerOpen}
        onClose={() => {
          setLanguagePickerOpen(false);
        }}
        returnTarget="profile"
      />
    </View>
  );
}
