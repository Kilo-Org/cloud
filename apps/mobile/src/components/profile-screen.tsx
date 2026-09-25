/* eslint-disable max-lines -- The profile screen composes Credits, Agents, Reviews, Organization, Linked accounts, App, Restore Purchases, and Actions; each section is a small rendered surface that mirrors the shared ConfigureRow/Text-header pattern. Splitting would re-encode the same hooks. */
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  BookOpenCheck,
  Building2,
  GitMerge,
  GitPullRequest,
  KeyRound,
  Lock,
  LogOut,
  MessageSquare,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from '@/components/ui/icons';
import { Alert, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { ActionTile } from '@/components/profile-action-tile';
import { CreditsCard } from '@/components/profile-credits-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useDeleteAccount } from '@/components/use-delete-account';
import { useSignOutConfirmation } from '@/components/use-sign-out-confirmation';
import { i18n } from '@/i18n';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { useAuth } from '@/lib/auth/auth-context';
import { showFeedbackPrompt } from '@/lib/feedback';
import { useAfterInteractions } from '@/lib/hooks/use-after-interactions';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganization } from '@/lib/organization-context';
import {
  getCodeReviewerProfilePath,
  getProfileAgentScope,
  getProfilesPath,
  getPrReviewEntryPath,
} from '@/lib/profile-agent-navigation';
import { useScreenSideInsets } from '@/lib/screen-insets';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

const PROVIDER_LABEL_KEYS = {
  anaconda: 'profile.providerAnaconda',
  apple: 'profile.providerApple',
  discord: 'profile.providerDiscord',
  email: 'common.email',
  'fake-login': 'profile.providerTestAccount',
  github: 'common.github',
  gitlab: 'common.gitlab',
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
  const { left, right } = useScreenSideInsets();
  const scrollStyle = { marginLeft: left, marginRight: right };
  const { signOut, token } = useAuth();
  const router = useRouter();
  const trpc = useTRPC();
  const { organizationId, isLoaded: organizationContextLoaded } = useOrganization();
  const isAuthenticated = token != null;
  // The account queries wait for the tab transition to settle, but the hook
  // bounds that wait: an interaction queue that never reports idle (an
  // automated UI session holds one open) must not hide the Linked accounts row,
  // the only place the signed-in address renders.
  const afterInteractions = useAfterInteractions();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  // One destructive confirm for both platforms: the in-app dialog carries the
  // destructive (red) affordance on iOS and Android alike, so the sign-out
  // path never branches on the platform. The confirmation itself, and its
  // rationale, live in `useSignOutConfirmation`.
  const { confirmVisible, requestSignOut, dismissConfirm, confirmSignOut } = useSignOutConfirmation(
    () => void signOut()
  );
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

  const {
    phase: deletePhase,
    isPending: deletePending,
    devCode,
    beginDelete,
    submitCode,
    setCode,
  } = useDeleteAccount();

  // Delete account keeps the native alert: Android's AppCompat dialog takes its
  // panel and action accent from the activity theme, which the
  // `plugins/withAndroidAlertDialogTheme` prebuild overlay points at the app
  // tokens, and iOS renders the same call as a `UIAlertController` that already
  // follows the device appearance.
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

  const showPrivacyChoices = () => {
    router.push('/(app)/consent?mode=review' as Href);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.profile')} size="large" showBackButton={false} />
      <TabScreenScrollView
        className="flex-1"
        style={scrollStyle}
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Credits */}
        <CreditsCard orgs={orgs} enabled={isAuthenticated} />

        {/* Code Reviewer */}
        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('common.agents')}
          </Text>
          <ConfigureRow
            icon={GitPullRequest}
            title={t('common.codeReviewer')}
            subtitle={t('profile.codeReviewerSubtitle')}
            hue="honey"
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
            title={t('common.securityAgent')}
            subtitle={t('profile.securityAgentSubtitle')}
            hue="honey"
            className="rounded-lg bg-secondary px-3"
            disabled={!agentScope}
            onPress={() => {
              if (agentScope) {
                router.push(getSecurityAgentPath(agentScope));
              }
            }}
          />
          <ConfigureRow
            icon={SlidersHorizontal}
            title={t('profiles.title')}
            subtitle={t('profiles.entrySubtitle')}
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push(getProfilesPath());
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
              title={t('common.prReview')}
              subtitle={t('profile.prReviewSubtitle')}
              hue="gold"
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
              {t('common.organization')}
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
                hue="lime"
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

        {/* App */}
        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('profile.app')}
          </Text>
          <ConfigureRow
            icon={SlidersHorizontal}
            title={t('common.preferences')}
            subtitle={t('profile.preferencesSubtitle')}
            hue="sage"
            className="rounded-lg bg-secondary px-3"
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/preferences' as Href);
            }}
          />
          {/* Permanent replay entry: opens the tour at any time, including
              after the account finished or skipped it. Opening it is an
              explicit user action, never a re-arm of the auto-open. */}
          <ConfigureRow
            icon={BookOpenCheck}
            title={t('tour.tutorialLabel')}
            hue="sage"
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push('/(app)/tour' as Href);
            }}
          />
        </View>

        {/* Linked accounts — hide the whole section when there are no linked
            providers (and we're not loading/erroring) so the header never dangles. */}
        {/* No layout animation on this section: siblings above mount/resize
            asynchronously; LinearTransition would animate this container's
            position lag as a visible header overlap.
            The rows below carry no entering fade either: a Reanimated entering
            animation does not run while the app is backgrounded, so the row
            stayed mounted at opacity 0 and left the header alone above the tab
            bar (Android `profile-error`, 2026-09-22). The skeleton reserves the
            row's height, so painting a row directly cannot shift the sections
            below — only the skeleton's exit fade remains. */}
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
                {/* Content-shaped skeleton (icon tile + two text bars in the
                    row's own bg-secondary card): a plain block read as an
                    empty box in the e5 spot check (2026-09-07). Heights sum to
                    the ConfigureRow row (py-3 + 38 text block) so the swap to
                    real rows does not shift the sections below. Bars are
                    bg-muted-soft: the theme's bg-muted equals bg-secondary,
                    so default-tone bars were invisible here (b911 e2 spot
                    check). */}
                <View className="flex-row items-center gap-3 rounded-lg bg-secondary px-3 py-3">
                  <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg bg-muted-soft" />
                  <View className="flex-1 gap-0.5">
                    <Skeleton className="h-5 w-32 rounded bg-muted-soft" />
                    <Skeleton className="h-4 w-48 rounded bg-muted-soft" />
                  </View>
                </View>
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
              <View key={`${p.provider}-${p.email}`}>
                <ConfigureRow
                  icon={KeyRound}
                  title={providerLabel(p.provider)}
                  subtitle={p.email}
                  subtitleNumberOfLines={1}
                  hue="moss"
                  className="rounded-lg bg-secondary px-3"
                  last={index === data.providers.length - 1}
                />
              </View>
            ))}
          </View>
        )}

        {/* Actions — stacked full-width tiles so labels never clip side-by-side at max Dynamic Type */}
        <View className="mt-6 gap-3">
          <ActionTile
            icon={MessageSquare}
            label={t('profile.feedback')}
            hue="fern"
            onPress={() => {
              showFeedbackPrompt(userId);
            }}
          />
          <ActionTile
            icon={Lock}
            label={t('profile.privacyChoices')}
            hue="fern"
            onPress={showPrivacyChoices}
          />
          <ActionTile
            icon={LogOut}
            label={t('common.signOut')}
            hue="fern"
            onPress={requestSignOut}
          />
          <ActionTile
            icon={Trash2}
            label={t('profile.deleteAccount')}
            hue="fern"
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

      {confirmVisible && (
        <DestructiveConfirmDialog
          title={t('profile.signOutTitle')}
          message={t('profile.signOutMessage')}
          confirmLabel={t('common.signOut')}
          onCancel={dismissConfirm}
          onConfirm={confirmSignOut}
        />
      )}
    </View>
  );
}
