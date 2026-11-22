/* eslint-disable max-lines -- The profile screen composes Credits, Agents, Reviews, Organization, Linked accounts, App, Restore Purchases, and Actions; each section is a small rendered surface that mirrors the shared ConfigureRow/Text-header pattern. Splitting would re-encode the same hooks. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Keyboard, type LayoutChangeEvent, type ScrollViewInstance, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { useConfirmDialog } from '@/components/ui/dialog';
import {
  CONTEXT_CONTROL_INLINE_MIN_DP,
  ContextControl,
  useContextPicker,
} from '@/components/context-control';
import { DeleteAccountCodeCard } from '@/components/delete-account-code-card';
import { CreditsCard, type CreditsCardOrgList } from '@/components/profile-credits-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import {
  SettingsSearchField,
  SettingsSearchResults,
} from '@/components/settings-search/settings-search';
import {
  SettingsSearchScrollView,
  SettingsTarget,
} from '@/components/settings-search/settings-target';
import {
  type SettingsSearchResult,
  useSettingsSearch,
} from '@/components/settings-search/use-settings-search';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { DirectionalLogOut } from '@/components/ui/directional-icons';
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
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
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
import {
  defineSetting,
  type SettingDefinition,
  type SettingsSearchSource,
  type SettingsTargetProps,
} from '@/lib/settings-search/definitions';
import { useIntegrationSearchSource } from '@/lib/settings-search/integration-source';
import { NOTIFICATION_SETTINGS_SOURCES } from '@/lib/settings-search/notification-sources';
import { PREFERENCE_SETTINGS_SOURCES } from '@/lib/settings-search/preference-sources';
import { PRIVACY_SETTINGS_SOURCE } from '@/lib/settings-search/privacy-source';
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

/**
 * Every permanent row on the Profile tab, grouped the way the screen renders it.
 * A section's `settings` object is both the render lookup and the search index
 * source (its values), so adding a definition to a section indexes it without a
 * second registration. Ids travel as the `settingsTarget` route param: keep
 * them stable.
 *
 * Credits, linked accounts and the header's account picker are not settings:
 * their values (a balance, a provider email, the active scope) change with the
 * account and are deliberately absent from the index.
 */
const PROFILE_SETTING_SECTIONS = {
  usage: {
    settings: {
      usage: defineSetting('profile.usage', 'usage.title'),
    },
  },
  agents: {
    context: ['common.agents'],
    settings: {
      codeReviewer: defineSetting('profile.codeReviewer', 'common.codeReviewer'),
      securityAgent: defineSetting('profile.securityAgent', 'common.securityAgent'),
      profiles: defineSetting('profile.profiles', 'profiles.title'),
      triggers: defineSetting('profile.triggers', 'cloudAgent.triggers.title'),
    },
  },
  reviews: {
    context: ['profile.reviews'],
    settings: {
      prReview: defineSetting('profile.prReview', 'common.prReview'),
    },
  },
  organization: {
    context: ['common.organization'],
    settings: {
      createOrganization: defineSetting('profile.organization.create', 'organization.create.title'),
    },
  },
  app: {
    context: ['profile.app'],
    settings: {
      nativeRemote: defineSetting('profile.nativeRemote', 'nativeRemote.title'),
      preferences: defineSetting('profile.preferences', 'common.preferences'),
      agentBriefing: defineSetting('profile.agentBriefing', 'agentBriefing.title'),
      tutorial: defineSetting('profile.tutorial', 'tour.tutorialLabel'),
      changelog: defineSetting('profile.changelog', 'profile.changelog'),
    },
  },
  integrations: {
    context: ['integrations.sectionTitle'],
    settings: {
      integrations: defineSetting('profile.integrations', 'integrations.title'),
    },
  },
  actions: {
    settings: {
      feedback: defineSetting('profile.feedback', 'profile.feedback'),
      privacyChoices: defineSetting('profile.privacyChoices', 'profile.privacyChoices', 'privacy'),
      signOut: defineSetting('profile.signOut', 'common.signOut', 'signOut'),
      deleteAccount: defineSetting('profile.deleteAccount', 'profile.deleteAccount'),
    },
  },
} as const;

/**
 * The organization row's visible label follows the active scope. The three
 * variants share one rendered row, so only the selected one joins the index.
 */
const PROFILE_ORGANIZATION_ROWS = {
  select: defineSetting('profile.organization.select', 'organization.boundary.selectOrganization'),
  view: defineSetting('profile.organization.view', 'profile.viewOrganization'),
  manage: defineSetting('profile.organization.manage', 'profile.manageOrganization'),
} as const;

/** Every row the JSX renders, by name. Derived from the sections above. */
const PROFILE_SETTINGS = {
  ...PROFILE_SETTING_SECTIONS.usage.settings,
  ...PROFILE_SETTING_SECTIONS.agents.settings,
  ...PROFILE_SETTING_SECTIONS.reviews.settings,
  ...PROFILE_SETTING_SECTIONS.organization.settings,
  ...PROFILE_SETTING_SECTIONS.app.settings,
  ...PROFILE_SETTING_SECTIONS.integrations.settings,
  ...PROFILE_SETTING_SECTIONS.actions.settings,
  selectOrganization: PROFILE_ORGANIZATION_ROWS.select,
  viewOrganization: PROFILE_ORGANIZATION_ROWS.view,
  manageOrganization: PROFILE_ORGANIZATION_ROWS.manage,
};

/** The organization row's label and destination depend on the active scope. */
function organizationSetting(organizationId: string | null, role: string | undefined) {
  if (organizationId == null) {
    return PROFILE_SETTINGS.selectOrganization;
  }
  return role === 'member'
    ? PROFILE_SETTINGS.viewOrganization
    : PROFILE_SETTINGS.manageOrganization;
}

export function ProfileScreen({ settingsTarget: routeTarget }: SettingsTargetProps = {}) {
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
    error: organizationsFailure,
    refetch: refetchOrganizations,
  } = useOrganizationsList({ enabled: afterIdle });
  // The Agents section resolves its scope from this list, so the read waits out
  // the first paint instead of joining it.
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

  // The credits card draws a money role's organization balance from this list,
  // so it needs the read's pending and failed windows kept apart: one
  // `undefined` would make it paint the member spend balance — `$0.00` for a
  // billing manager — while the list is still on its way.
  //
  // Rows come first: React Query keeps `data` through a failed background
  // refetch, so a list that already answered keeps painting its balances even
  // while the retry fails, and the error arm is only for a read with no rows.
  // That arm carries the read's own error, because the card's failure kind
  // names the cause from it: a refusal must not paint as a retryable failure.
  let creditsOrgList: CreditsCardOrgList = { status: 'loading' };
  if (orgs !== undefined) {
    creditsOrgList = { status: 'ready', orgs };
  } else if (organizationsError) {
    creditsOrgList = {
      status: 'error',
      error: organizationsFailure,
      retry: () => {
        void refetchOrganizations();
      },
    };
  }

  const { userId } = useCurrentUserId({ enabled: isAuthenticated });
  // The prompt's surface is platform-specific (`feedback-prompt-platform.ts`);
  // the tile requests it and the screen renders whichever one applies.
  const feedbackPrompt = useFeedbackPrompt();

  const { t } = useTranslation();
  // Reactive: a connectivity commit re-renders the error-variant selection, so
  // a read that settled by failing while the device is confirmed offline says
  // so instead of presenting itself as a server fault.
  const committedConnectivity = useCommittedConnectivityStatus();

  // The root rows this account renders right now. A row is indexed only when
  // its own branch renders it, so search can never offer a control that is not
  // on the screen.
  const showNativeRemote = __DEV__ && Boolean(SESSION_SYNC_URL);
  const showOrganizationRow = organizationId != null || hasOrganizations;
  const organizationRowSetting = organizationSetting(organizationId, orgRole);
  const integrationSettingsSource = useIntegrationSearchSource();
  const searchSources = useMemo<readonly SettingsSearchSource[]>(() => {
    const sections = PROFILE_SETTING_SECTIONS;
    const sources: SettingsSearchSource[] = [
      { settings: Object.values(sections.usage.settings) },
      {
        context: sections.agents.context,
        settings: Object.values(sections.agents.settings),
      },
      {
        context: sections.reviews.context,
        settings: Object.values(sections.reviews.settings),
      },
    ];
    if (showOrganizationSection && !organizationsError) {
      const organizationSettings: SettingDefinition[] = Object.values(
        sections.organization.settings
      );
      if (showOrganizationRow) {
        // The chosen scope's row shares the section's one rendered control.
        organizationSettings.unshift(organizationRowSetting);
      }
      sources.push({ context: sections.organization.context, settings: organizationSettings });
    }
    sources.push({
      context: sections.app.context,
      settings: Object.values(sections.app.settings).filter(
        setting => showNativeRemote || setting.id !== sections.app.settings.nativeRemote.id
      ),
    });
    sources.push({
      context: sections.integrations.context,
      settings: Object.values(sections.integrations.settings),
    });
    sources.push({ settings: Object.values(sections.actions.settings) });
    sources.push(PRIVACY_SETTINGS_SOURCE);
    sources.push(integrationSettingsSource);
    sources.push(...PREFERENCE_SETTINGS_SOURCES, ...NOTIFICATION_SETTINGS_SOURCES);
    return sources;
  }, [
    integrationSettingsSource,
    organizationsError,
    showNativeRemote,
    showOrganizationRow,
    showOrganizationSection,
    organizationRowSetting,
  ]);

  const settingsSearch = useSettingsSearch(searchSources);
  // The row a root result selected and the selection that asked for it. It
  // stays while the query clears, so the person lands on the highlighted
  // control instead of the results vanishing with nothing shown. The counter
  // distinguishes a second tap on the same result from the first, so the row is
  // revealed again instead of staying where the previous scroll left it.
  // Nested results navigate instead; neither path runs the row's own action.
  const [settingsTarget, setSettingsTarget] = useState(
    routeTarget === undefined ? undefined : { id: routeTarget, attempt: 0 }
  );

  const selectSetting = useCallback(
    (entry: SettingsSearchResult['entry']) => {
      // An accepted result ends the search interaction: the keyboard goes away
      // before the row is revealed or the destination opens, so neither lands
      // behind the IME. The results list keeps the first tap (`handled` taps).
      Keyboard.dismiss();
      settingsSearch.clear();
      if (entry.path) {
        // Expo Router's per-route Href union cannot associate this union of
        // static pathnames with a single arm. SettingsPath excludes routes
        // whose params are required, so each indexed pathname accepts this shape.
        const href = {
          pathname: entry.path,
          params: { ...entry.params, settingsTarget: entry.id },
        };
        router.push(href as Href);
        return;
      }
      setSettingsTarget(current => ({ id: entry.id, attempt: (current?.attempt ?? 0) + 1 }));
    },
    [router, settingsSearch]
  );

  // Personal context has no selected organization to label, so its row opens
  // the account picker; otherwise the row names the destination for the active
  // organization's role.
  const organizationRow = (
    <SettingsTarget item={organizationRowSetting}>
      <ConfigureRow
        icon={Building2}
        title={t(organizationRowSetting.label)}
        hue="lime"
        disabled={organizationId != null && !orgRole}
        onPress={
          organizationId == null
            ? openPicker
            : () => {
                router.push('/(app)/(tabs)/(3_profile)/organization' as Href);
              }
        }
      />
    </SettingsTarget>
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
    code: deleteCode,
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
        inlineActionsMinWidth={CONTEXT_CONTROL_INLINE_MIN_DP}
      />
      <SettingsSearchField
        query={settingsSearch.query}
        onChangeText={text => {
          settingsSearch.setQuery(text);
        }}
        inputRef={settingsSearch.inputRef}
      />
      <SettingsSearchScrollView
        ref={deleteScrollRef}
        settingsTarget={settingsTarget?.id}
        revealKey={settingsTarget?.attempt}
        className="flex-1"
        contentContainerClassName={settingsSearch.active ? undefined : SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
        onKeyboardOcclusionChange={setDeleteKeyboardOcclusion}
        onLayout={onDeleteScrollLayout}
      >
        {settingsSearch.active ? (
          <SettingsSearchResults results={settingsSearch.results} onSelect={selectSetting} />
        ) : (
          <>
            {/* Credits: the balance and its purchase action, plus the spend entry,
            because spend and remaining credits are the two halves of the same
            question. */}
            <Section>
              <CreditsCard orgList={creditsOrgList} enabled={isAuthenticated} />
              <RowGroup leadingTile>
                <SettingsTarget item={PROFILE_SETTINGS.usage}>
                  <ConfigureRow
                    icon={LineChart}
                    title={t(PROFILE_SETTINGS.usage.label)}
                    subtitle={t('usage.entrySubtitle')}
                    hue="sage"
                    onPress={() => {
                      router.push('/(app)/usage' as Href);
                    }}
                  />
                </SettingsTarget>
              </RowGroup>
            </Section>

            <Section label={t('common.agents')}>
              <RowGroup leadingTile>
                <SettingsTarget item={PROFILE_SETTINGS.codeReviewer}>
                  <ConfigureRow
                    icon={GitPullRequest}
                    title={t(PROFILE_SETTINGS.codeReviewer.label)}
                    subtitle={t('profile.codeReviewerSubtitle')}
                    hue="honey"
                    disabled={!agentScope}
                    onPress={() => {
                      if (agentScope) {
                        router.push(getCodeReviewerProfilePath(agentScope));
                      }
                    }}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.securityAgent}>
                  <ConfigureRow
                    icon={ShieldCheck}
                    title={t(PROFILE_SETTINGS.securityAgent.label)}
                    subtitle={t('profile.securityAgentSubtitle')}
                    hue="honey"
                    disabled={!agentScope}
                    onPress={() => {
                      if (agentScope) {
                        router.push(getSecurityAgentPath(agentScope));
                      }
                    }}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.profiles}>
                  <ConfigureRow
                    icon={Users}
                    title={t(PROFILE_SETTINGS.profiles.label)}
                    subtitle={t('profiles.entrySubtitle')}
                    // Agents step: the row lists the agent profiles, and its two
                    // siblings in this section already carry `honey`. The neutral tile
                    // made one row of three read as disabled.
                    hue="honey"
                    onPress={() => {
                      router.push(getProfilesPath());
                    }}
                  />
                </SettingsTarget>
                {/* Cloud Agent triggers are a native screen, for the scope in view:
                the personal triggers, or the selected organization's. */}
                <SettingsTarget item={PROFILE_SETTINGS.triggers}>
                  <ConfigureRow
                    icon={Workflow}
                    title={t(PROFILE_SETTINGS.triggers.label)}
                    subtitle={t('cloudAgent.triggers.subtitle')}
                    hue="honey"
                    onPress={() => {
                      router.push(triggersListHref(organizationId ?? undefined));
                    }}
                  />
                </SettingsTarget>
              </RowGroup>
            </Section>

            {/* PR Review */}
            <Section label={t('profile.reviews')}>
              <RowGroup leadingTile>
                <SettingsTarget item={PROFILE_SETTINGS.prReview}>
                  <ConfigureRow
                    icon={GitMerge}
                    title={t(PROFILE_SETTINGS.prReview.label)}
                    subtitle={t('common.prReviewSubtitle')}
                    hue="gold"
                    onPress={() => {
                      router.push(getPrReviewEntryPath());
                    }}
                  />
                </SettingsTarget>
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
                    {showOrganizationRow && organizationRow}
                    <SettingsTarget item={PROFILE_SETTINGS.createOrganization}>
                      <ConfigureRow
                        icon={Plus}
                        title={t(PROFILE_SETTINGS.createOrganization.label)}
                        hue="lime"
                        onPress={() => {
                          router.push(CREATE_ORGANIZATION_HREF);
                        }}
                      />
                    </SettingsTarget>
                  </RowGroup>
                )}
              </Section>
            )}

            {/* App */}
            <Section label={t('profile.app')}>
              <RowGroup leadingTile>
                {showNativeRemote && (
                  <SettingsTarget item={PROFILE_SETTINGS.nativeRemote}>
                    <ConfigureRow
                      icon={SlidersHorizontal}
                      title={t(PROFILE_SETTINGS.nativeRemote.label)}
                      hue="sage"
                      onPress={() => {
                        router.push('/(app)/native-remote' as Href);
                      }}
                    />
                  </SettingsTarget>
                )}
                <SettingsTarget item={PROFILE_SETTINGS.preferences}>
                  <ConfigureRow
                    icon={SlidersHorizontal}
                    title={t(PROFILE_SETTINGS.preferences.label)}
                    subtitle={t('profile.preferencesSubtitle')}
                    hue="sage"
                    onPress={() => {
                      router.push('/(app)/(tabs)/(3_profile)/preferences' as Href);
                    }}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.agentBriefing}>
                  <ConfigureRow
                    icon={BookOpenCheck}
                    title={t(PROFILE_SETTINGS.agentBriefing.label)}
                    subtitle={t('agentBriefing.historyHint')}
                    hue="sage"
                    onPress={() => {
                      router.push('/(app)/agent-briefing' as Href);
                    }}
                  />
                </SettingsTarget>
                {/* Permanent replay entry: opens the tour at any time, including
                after the account finished or skipped it. Opening it is an
                explicit user action, never a re-arm of the auto-open. */}
                <SettingsTarget item={PROFILE_SETTINGS.tutorial}>
                  <ConfigureRow
                    icon={BookOpenCheck}
                    title={t(PROFILE_SETTINGS.tutorial.label)}
                    hue="sage"
                    onPress={() => {
                      router.push('/(app)/tour' as Href);
                    }}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.changelog}>
                  <ConfigureRow
                    icon={Sparkles}
                    title={t(PROFILE_SETTINGS.changelog.label)}
                    hue="sage"
                    onPress={() => {
                      router.push('/(app)/changelog' as Href);
                    }}
                  />
                </SettingsTarget>
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
                <SettingsTarget item={PROFILE_SETTINGS.integrations}>
                  <ConfigureRow
                    icon={Plug}
                    title={t(PROFILE_SETTINGS.integrations.label)}
                    subtitle={t('integrations.entrySubtitle')}
                    hue="pine"
                    onPress={() => {
                      router.push('/(app)/(tabs)/(3_profile)/integrations' as Href);
                    }}
                  />
                </SettingsTarget>
              </RowGroup>
            </Section>

            <Section>
              <RowGroup leadingTile>
                <SettingsTarget item={PROFILE_SETTINGS.feedback}>
                  <ConfigureRow
                    variant="action"
                    icon={MessageSquare}
                    title={t(PROFILE_SETTINGS.feedback.label)}
                    hue="fern"
                    onPress={() => {
                      void feedbackPrompt.requestPrompt(userId);
                    }}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.privacyChoices}>
                  <ConfigureRow
                    variant="action"
                    icon={Lock}
                    title={t(PROFILE_SETTINGS.privacyChoices.label)}
                    hue="fern"
                    onPress={showPrivacyChoices}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.signOut}>
                  <ConfigureRow
                    variant="action"
                    icon={DirectionalLogOut}
                    title={t(PROFILE_SETTINGS.signOut.label)}
                    hue="fern"
                    onPress={requestSignOut}
                  />
                </SettingsTarget>
                <SettingsTarget item={PROFILE_SETTINGS.deleteAccount}>
                  <ConfigureRow
                    variant="action"
                    icon={Trash2}
                    title={t(PROFILE_SETTINGS.deleteAccount.label)}
                    hue="fern"
                    destructive
                    disabled={deletePending}
                    onPress={confirmDeleteAccount}
                  />
                </SettingsTarget>
              </RowGroup>

              {(deletePhase === 'awaiting-code' || deletePhase === 'executing') && (
                <DeleteAccountCodeCard
                  initialCode={deleteCode}
                  canSubmitCode={canSubmitCode}
                  executing={deletePhase === 'executing'}
                  onChangeCode={setCode}
                  onSubmit={submitCode}
                />
              )}

              <Text variant="caption" className="text-center">
                v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
              </Text>
            </Section>
          </>
        )}
      </SettingsSearchScrollView>

      {confirmDialog}

      {feedbackPrompt.promptDialog}
    </View>
  );
}
