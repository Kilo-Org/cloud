/* eslint-disable max-lines -- The profile screen composes Credits, Agents, Reviews, Organization, Linked accounts, App, Restore Purchases, and Actions; each section is a small rendered surface that mirrors the shared ConfigureRow/Text-header pattern. Splitting would re-encode the same hooks. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpenCheck,
  Building2,
  GitMerge,
  GitPullRequest,
  KeyRound,
  LineChart,
  Lock,
  MessageSquare,
  Plug,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  Workflow,
} from '@/components/ui/icons';
import { type LayoutChangeEvent, type ScrollViewInstance, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { useConfirmDialog } from '@/components/ui/dialog';
import { ContextControl, useContextPicker } from '@/components/context-control';
import { CreditsCard } from '@/components/profile-credits-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { DirectionalLogOut } from '@/components/ui/directional-icons';
import { FormField } from '@/components/ui/form-field';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { useDeleteAccount } from '@/components/use-delete-account';
import { useFeedbackPrompt } from '@/components/use-feedback-prompt';
import { useAuth } from '@/lib/auth/auth-context';
import { providerLabel } from '@/lib/auth/provider-label';
import { SESSION_SYNC_URL } from '@/lib/config';
import { triggersListHref } from '@/lib/cloud-triggers/trigger-routes';
import { useAfterIdle } from '@/lib/hooks/use-after-idle';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useOrganization } from '@/lib/organization-context';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';
import {
  getCodeReviewerProfilePath,
  getProfileAgentScope,
  getProfilesPath,
  getPrReviewEntryPath,
} from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

type AuthProvider =
  inferRouterOutputs<MobileRouter>['user']['getAuthProviders']['providers'][number];

/**
 * What the Linked accounts section shows. One arm at a time, so rows and a load
 * error can never stand together, and a failed refetch over retained rows is its
 * own arm instead of claiming the accounts could not be loaded.
 */
type LinkedAccountsView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'skeleton' }
  | { readonly kind: 'error' }
  | { readonly kind: 'rows'; readonly providers: readonly AuthProvider[] }
  | { readonly kind: 'rowsStale'; readonly providers: readonly AuthProvider[] };

/** One answer for the Linked accounts section: rows and a load error never coexist. */
function linkedAccountsView(
  providers: readonly AuthProvider[] | undefined,
  failed: boolean
): LinkedAccountsView {
  if (providers === undefined) {
    return failed ? { kind: 'error' } : { kind: 'skeleton' };
  }
  if (providers.length === 0) {
    // A settled empty read keeps the section hidden, as it always has.
    return failed ? { kind: 'error' } : { kind: 'hidden' };
  }
  return failed ? { kind: 'rowsStale', providers } : { kind: 'rows', providers };
}

export function ProfileScreen() {
  const { signOut, token } = useAuth();
  const router = useRouter();
  const trpc = useTRPC();
  const deleteScrollRef = useRef<ScrollViewInstance>(null);
  const [deleteKeyboardOcclusion, setDeleteKeyboardOcclusion] = useState(0);
  const [deleteScrollFrameHeight, setDeleteScrollFrameHeight] = useState(0);
  const { organizationId, isLoaded: organizationContextLoaded } = useOrganization();
  const isAuthenticated = token != null;
  const afterIdle = useAfterIdle();
  // Both destructive confirms on this screen go through the app's dialog: it
  // carries the destructive (red) affordance on iOS and Android alike, because
  // Android's native `AlertDialog` paints every button with the theme accent.
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const {
    data,
    isError: providersError,
    isFetching: providersFetching,
    refetch: refetchProviders,
  } = useQuery({
    ...trpc.user.getAuthProviders.queryOptions(),
    enabled: isAuthenticated && afterIdle,
    // A paused read leaves the Linked accounts row with neither content nor an
    // error surface.
    ...SETTLE_WHILE_OFFLINE,
  });
  const {
    data: orgs,
    isFetching: organizationsFetching,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: isAuthenticated && afterIdle,
    // The Agents section resolves its scope from this list, so a paused read
    // leaves the organization section and its rows waiting.
    ...SETTLE_WHILE_OFFLINE,
  });
  const agentScope = organizationContextLoaded
    ? getProfileAgentScope(organizationId, orgs)
    : undefined;
  const { openPicker } = useContextPicker(orgs);
  const selectedOrg = orgs?.find(org => org.organizationId === organizationId);
  const orgRole = selectedOrg?.role;
  // A settled read that lists no memberships still keeps the section: its Create
  // organization row is the app's only entry to that flow, so an account with no
  // organization has to be able to start one. The account-picker row is dropped
  // in that case alone — it would list Personal and nothing else.
  const hasOrganizations = (orgs?.length ?? 0) > 0;
  // The Organization section stays on Profile in every credit-account context:
  // a Personal context still offers the account picker when the account has
  // memberships, so organization management is not gated behind the credits
  // account control. The restore decides the context first, so the chooser never
  // paints for a frame before the active organization's row replaces it. A
  // memberships read that failed keeps the section too: its error and Retry live
  // inside this block, so hiding the section while the list is unavailable would
  // drop the only retry. A read that is still loading, or paused offline before
  // it ever fetched, keeps the section hidden: no empty state paints before the
  // list settles.
  const showOrganizationSection =
    organizationId != null ||
    (organizationContextLoaded && (organizationsError || orgs !== undefined));

  const { userId } = useCurrentUserId({ enabled: isAuthenticated });
  // The prompt's surface is platform-specific (`feedback-prompt-platform.ts`);
  // the tile requests it and the screen renders whichever one applies.
  const feedbackPrompt = useFeedbackPrompt();

  const { t } = useTranslation();
  // Reactive: a connectivity commit re-renders the error-variant selection, so
  // a read that settled by failing while the device is confirmed offline says
  // so instead of presenting itself as a server fault.
  const committedConnectivity = useCommittedConnectivityStatus();

  // Personal context has no selected organization to label, so its row opens
  // the account picker; otherwise the row names the destination for the active
  // organization's role.
  const organizationRow =
    organizationId == null ? (
      <ConfigureRow
        icon={Building2}
        title={t('organization.boundary.selectOrganization')}
        hue="lime"
        onPress={openPicker}
      />
    ) : (
      <ConfigureRow
        icon={Building2}
        title={
          orgRole === 'member' ? t('profile.viewOrganization') : t('profile.manageOrganization')
        }
        hue="lime"
        disabled={!orgRole}
        onPress={() => {
          router.push('/(app)/(tabs)/(3_profile)/organization' as Href);
        }}
      />
    );

  const requestSignOut = () => {
    confirm({
      title: t('profile.signOutTitle'),
      message: t('profile.signOutMessage'),
      confirmLabel: t('common.signOut'),
      onConfirm: () => {
        void signOut();
      },
    });
  };

  const {
    phase: deletePhase,
    isPending: deletePending,
    devCode,
    canSubmitCode,
    beginDelete,
    submitCode,
    setCode,
  } = useDeleteAccount();

  // The confirmation code renders one row above the destructive submit. The
  // block is appended below the offset the user was parked at, and Android's
  // edge-to-edge window does not resize for the IME, so the submit stays below
  // the viewport (and, with the keyboard up, behind the IME). The shared scroll
  // view ends its viewport at the IME's top edge; reveal the block when it
  // appears and again once the IME's occlusion lands, so the submit clears the
  // tab bar and the keyboard. Android may commit the IME lift after
  // `keyboardDidShow` reports, so the reveal also watches the scroll view's
  // committed frame height and reruns once that frame reaches its final size.
  // The occlusion arrives from the shared scroll view that already tracks it,
  // so this screen does not read the keyboard itself.
  useEffect(() => {
    if (deletePhase !== 'awaiting-code' && deletePhase !== 'executing') {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      deleteScrollRef.current?.scrollToEnd({ animated: false });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [deletePhase, deleteKeyboardOcclusion, deleteScrollFrameHeight]);

  const onDeleteScrollLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    // A guarded update: an equal height leaves the state identity untouched so
    // the reveal effect does not rerun on every unrelated layout pass.
    setDeleteScrollFrameHeight(current => (current === height ? current : height));
  }, []);

  // The confirmation is the app's own dialog, not the native alert: Android's
  // `AlertDialog` paints every button with the theme accent, so
  // `style: 'destructive'` never reaches the screen there. The Profile screen
  // is a tab, so nothing can be presented over it and the portal dialog is
  // always visible.
  const confirmDeleteAccount = () => {
    confirm({
      title: t('profile.deleteAccountTitle'),
      message: t('profile.deleteAccountMessage'),
      confirmLabel: t('profile.deleteAccountConfirm'),
      onConfirm: beginDelete,
    });
  };

  const showPrivacyChoices = () => {
    router.push('/(app)/consent?mode=review' as Href);
  };

  // One answer per render: the section exists only where it has content, rows
  // and an error never stand together, and a failed refetch over rows keeps
  // them with a stale line instead of claiming the accounts could not load.
  const linkedAccounts = linkedAccountsView(data?.providers, providersError);
  const listedProviders =
    linkedAccounts.kind === 'rows' || linkedAccounts.kind === 'rowsStale'
      ? linkedAccounts.providers
      : null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.profile')}
        size="large"
        showBackButton={false}
        inlineActions={<ContextControl />}
        allowInlineActionsStacking={false}
      />
      <TabScreenScrollView
        ref={deleteScrollRef}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
        onKeyboardOcclusionChange={setDeleteKeyboardOcclusion}
        onLayout={onDeleteScrollLayout}
      >
        {/* Credits: the balance and its purchase action, plus the spend entry,
            because spend and remaining credits are the two halves of the same
            question. */}
        <Section>
          <CreditsCard orgs={orgs} enabled={isAuthenticated} />
          <RowGroup leadingTile>
            <ConfigureRow
              icon={LineChart}
              title={t('usage.title')}
              subtitle={t('usage.entrySubtitle')}
              hue="sage"
              onPress={() => {
                router.push('/(app)/usage' as Href);
              }}
            />
          </RowGroup>
        </Section>

        <Section label={t('common.agents')}>
          <RowGroup leadingTile>
            <ConfigureRow
              icon={GitPullRequest}
              title={t('common.codeReviewer')}
              subtitle={t('profile.codeReviewerSubtitle')}
              hue="honey"
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
              disabled={!agentScope}
              onPress={() => {
                if (agentScope) {
                  router.push(getSecurityAgentPath(agentScope));
                }
              }}
            />
            <ConfigureRow
              icon={Users}
              title={t('profiles.title')}
              subtitle={t('profiles.entrySubtitle')}
              // Agents step: the row lists the agent profiles, and its two
              // siblings in this section already carry `honey`. The neutral tile
              // made one row of three read as disabled.
              hue="honey"
              onPress={() => {
                router.push(getProfilesPath());
              }}
            />
            {/* Cloud Agent triggers are a native screen, for the scope in view:
                the personal triggers, or the selected organization's. */}
            <ConfigureRow
              icon={Workflow}
              title={t('cloudAgent.triggers.title')}
              subtitle={t('cloudAgent.triggers.subtitle')}
              hue="honey"
              onPress={() => {
                router.push(triggersListHref(organizationId ?? undefined));
              }}
            />
          </RowGroup>
        </Section>

        {/* PR Review */}
        <Section label={t('profile.reviews')}>
          <RowGroup leadingTile>
            <ConfigureRow
              icon={GitMerge}
              title={t('common.prReview')}
              subtitle={t('common.prReviewSubtitle')}
              hue="gold"
              onPress={() => {
                router.push(getPrReviewEntryPath());
              }}
            />
          </RowGroup>
        </Section>

        {/* Organization */}
        {showOrganizationSection && (
          <Section label={t('common.organization')}>
            {organizationsError ? (
              <QueryError
                variant={committedConnectivity === 'offline' ? 'offline' : 'server'}
                placement="top"
                title={t('profile.couldNotLoadOrganization')}
                message={t('profile.couldNotLoadOrganizationDescription')}
                onRetry={() => void refetchOrganizations()}
                isRetrying={organizationsFetching}
              />
            ) : (
              <RowGroup leadingTile>
                {(organizationId != null || hasOrganizations) && organizationRow}
                <ConfigureRow
                  icon={Plus}
                  title={t('organization.create.title')}
                  hue="lime"
                  onPress={() => {
                    router.push(CREATE_ORGANIZATION_HREF);
                  }}
                />
              </RowGroup>
            )}
          </Section>
        )}

        {/* App */}
        <Section label={t('profile.app')}>
          <RowGroup leadingTile>
            {__DEV__ && SESSION_SYNC_URL && (
              <ConfigureRow
                icon={SlidersHorizontal}
                title={t('nativeRemote.title')}
                hue="sage"
                onPress={() => {
                  router.push('/(app)/native-remote' as Href);
                }}
              />
            )}
            <ConfigureRow
              icon={SlidersHorizontal}
              title={t('common.preferences')}
              subtitle={t('profile.preferencesSubtitle')}
              hue="sage"
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/preferences' as Href);
              }}
            />
            <ConfigureRow
              icon={BookOpenCheck}
              title={t('agentBriefing.title')}
              subtitle={t('agentBriefing.historyHint')}
              hue="sage"
              onPress={() => {
                router.push('/(app)/agent-briefing' as Href);
              }}
            />
            {/* Permanent replay entry: opens the tour at any time, including
                after the account finished or skipped it. Opening it is an
                explicit user action, never a re-arm of the auto-open. */}
            <ConfigureRow
              icon={BookOpenCheck}
              title={t('tour.tutorialLabel')}
              hue="sage"
              onPress={() => {
                router.push('/(app)/tour' as Href);
              }}
            />
            <ConfigureRow
              icon={Sparkles}
              title={t('profile.changelog')}
              hue="sage"
              onPress={() => {
                router.push('/(app)/changelog' as Href);
              }}
            />
          </RowGroup>
        </Section>

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
        {linkedAccounts.kind === 'hidden' ? null : (
          <Section label={t('profile.linkedAccounts')}>
            {linkedAccounts.kind === 'skeleton' ? (
              <Animated.View exiting={FadeOut.duration(150)}>
                {/* The group's own row shape, so the swap to the loaded rows
                    does not shift the sections below. */}
                <RowGroup>
                  <RowSkeleton tile subtitle />
                </RowGroup>
              </Animated.View>
            ) : null}

            {linkedAccounts.kind === 'error' ? (
              <QueryError
                variant={committedConnectivity === 'offline' ? 'offline' : 'server'}
                placement="top"
                title={t('profile.couldNotLoadAccounts')}
                onRetry={() => void refetchProviders()}
                isRetrying={providersFetching}
              />
            ) : null}

            {listedProviders === null ? null : (
              <RowGroup leadingTile>
                {listedProviders.map(p => (
                  <ConfigureRow
                    key={`${p.provider}-${p.email}`}
                    icon={KeyRound}
                    title={providerLabel(p.provider)}
                    subtitle={p.email}
                    subtitleNumberOfLines={1}
                    hue="moss"
                  />
                ))}
              </RowGroup>
            )}

            {linkedAccounts.kind === 'rowsStale' ? (
              <View className="flex-row items-center gap-3">
                <AccessibleStatus
                  tone="warn"
                  className="flex-1 text-xs"
                  message={t('agents.sessionList.couldNotRefresh')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => void refetchProviders()}
                  loading={providersFetching}
                >
                  {t('common.refresh')}
                </Button>
              </View>
            ) : null}
          </Section>
        )}

        {/* Connected services — the integrations hub. Its own section rather
            than a row in App: the hub manages external accounts, and its row
            takes the next curated hue step in reading order. */}
        <Section label={t('integrations.sectionTitle')}>
          <RowGroup leadingTile>
            <ConfigureRow
              icon={Plug}
              title={t('integrations.title')}
              subtitle={t('integrations.entrySubtitle')}
              hue="pine"
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/integrations' as Href);
              }}
            />
          </RowGroup>
        </Section>

        <Section>
          <RowGroup leadingTile>
            <ConfigureRow
              variant="action"
              icon={MessageSquare}
              title={t('profile.feedback')}
              hue="fern"
              onPress={() => {
                void feedbackPrompt.requestPrompt(userId);
              }}
            />
            <ConfigureRow
              variant="action"
              icon={Lock}
              title={t('profile.privacyChoices')}
              hue="fern"
              onPress={showPrivacyChoices}
            />
            <ConfigureRow
              variant="action"
              icon={DirectionalLogOut}
              title={t('common.signOut')}
              hue="fern"
              onPress={requestSignOut}
            />
            <ConfigureRow
              variant="action"
              icon={Trash2}
              title={t('profile.deleteAccount')}
              hue="fern"
              destructive
              disabled={deletePending}
              onPress={confirmDeleteAccount}
            />
          </RowGroup>

          {(deletePhase === 'awaiting-code' || deletePhase === 'executing') && (
            <Card className="gap-3">
              <FormField
                label={t('profile.confirmationCode')}
                placeholder={t('profile.confirmationCodePlaceholder')}
                keyboardType="number-pad"
                // Android only: keep the IME docked to the number-pad instead
                // of swapping to its full-screen extract editor, whose window
                // parks over the whole screen and buries the destructive submit
                // below it. The shared scroll view already reserves the docked
                // IME height and the reveal scrolls the block to its end, so
                // `TabScreenScrollView`'s occlusion reservation leaves the
                // submit above the keyboard without a dimensions change here.
                disableFullscreenUI
                defaultValue={devCode ?? undefined}
                onChangeText={setCode}
                editable={deletePhase !== 'executing'}
              />
              <Button
                variant="destructive"
                loading={deletePhase === 'executing'}
                disabled={deletePhase === 'executing' || !canSubmitCode}
                onPress={submitCode}
              >
                <Text>{t('profile.confirmDeletion')}</Text>
              </Button>
            </Card>
          )}

          <Text variant="caption" className="text-center">
            v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
          </Text>
        </Section>
      </TabScreenScrollView>

      {confirmDialog}

      {feedbackPrompt.promptDialog}
    </View>
  );
}
