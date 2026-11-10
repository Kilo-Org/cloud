/* eslint-disable max-lines -- The hub composes every organization row (money, members, Kilo Pass, rename) on one screen. */
import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { Bell, FileText, Pencil, Receipt, Users, Wallet } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { AddCreditsRow } from '@/components/add-credits-row';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  getOrgKiloPassRowState,
  type OrgKiloPassRowState,
} from '@/components/organization/org-kilo-pass-row-state';
import { OrgUsageStats } from '@/components/organization/org-usage-stats';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { IconButton } from '@/components/ui/icon-button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { NEUTRAL_TINT, type Tint, toneColor } from '@/lib/agent-color';
import { isolateLtrBidiText } from '@/lib/bidi';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { formatMoney, formatNumber } from '@/lib/format';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgKiloPassSummary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { cn } from '@/lib/utils';

type OrganizationHubScreenProps = Readonly<{
  /** Explicit org id from a deep link (e.g. /organizations/<id>/overview). */
  organizationIdOverride?: string;
}>;

export function OrganizationHubScreen({ organizationIdOverride }: OrganizationHubScreenProps = {}) {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary(organizationIdOverride);
  const { setOrganizationId } = useOrganization();
  const appliedOverrideRef = useRef<string | null>(null);

  // A deep-linked org id must become the persisted selection so tabs and
  // sibling screens keep working, but only after membership is confirmed
  // (org non-null) and only once per override.
  useEffect(() => {
    if (organizationIdOverride == null || org == null) {
      return;
    }
    if (appliedOverrideRef.current === organizationIdOverride) {
      return;
    }
    appliedOverrideRef.current = organizationIdOverride;
    setOrganizationId(organizationIdOverride);
  }, [organizationIdOverride, org, setOrganizationId]);

  const orgWithMembers = useOrgWithMembers(organizationId);
  // `organizations.list` carries the org's parent link, so the billing group
  // knows from its first frame whether this org has a Kilo Pass row instead of
  // adding one a request later and pushing the rows under it down. A device
  // that persisted the list before that field existed hydrates an entry
  // without it, and an entry written before an admin moved the organization
  // under a parent still says `null`, so the membership payload fills the gap
  // in both directions: a parent id from either payload makes this a child,
  // because only an admin change moves an organization under a parent after
  // creation and that id is never the stale side. A `null` confirms a
  // top-level organization only from the freshly fetched membership payload;
  // the list's own `null` is a cached value and leaves the link unknown until
  // membership answers.
  const listParentLink = org?.parentOrganizationId;
  const membershipParentLink = orgWithMembers.data?.parent_organization_id;
  const reportedParentLink = listParentLink ?? membershipParentLink;
  const topLevelConfirmed = membershipParentLink === null;
  const parentLink = reportedParentLink ?? (topLevelConfirmed ? null : undefined);
  // No membership payload and a failed or paused fetch: the payload that would
  // settle anything waiting on it will not arrive on its own.
  const membershipUnavailable =
    orgWithMembers.data == null && (orgWithMembers.isError || orgWithMembers.isPaused);
  // An unknown link keeps the row: it renders in its loading state instead of
  // appearing once a payload lands. Only a known child organization, which
  // carries its parent's id, has no Kilo Pass row.
  const isChildOrganization = parentLink != null;
  const showKiloPassRow = isMoneyRole(role) && !isChildOrganization;
  // The summary API is parent-only (`organizationParentBillingProcedure`
  // rejects child orgs and non-billing roles), so it fires only once the
  // membership payload confirms a top-level organization. A cached list entry
  // cannot confirm it, because the organization may have moved under a parent
  // since that entry was written.
  const kiloPassSummary = useOrgKiloPassSummary(
    organizationId,
    isMoneyRole(role) && parentLink === null
  );
  const mutations = useOrganizationMutations(organizationId ?? '');
  const [renameVisible, setRenameVisible] = useState(false);
  const { t } = useTranslation();
  // The same preference the Profile credits card obeys. Until the disk read
  // settles the choice is unknown, so the amount stays masked: the hub must
  // never paint an amount the person may have hidden one screen away.
  const { hideBalance, hasLoaded: hideBalanceLoaded } = useHideBalancePreference();
  const hideOrgBalance = hideBalance || !hideBalanceLoaded;

  if (isResolving || organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('common.organization')}
        organizationIdOverride={organizationIdOverride}
      />
    );
  }

  const showMoney = isMoneyRole(role);
  // An unknown parent link with no membership arriving is not a state the row
  // can settle into: it would keep its placeholder forever, so it offers the
  // retry that asks the membership payload again instead.
  const kiloPassLinkUnavailable = parentLink === undefined && membershipUnavailable;
  const kiloPassRowState = showKiloPassRow
    ? getOrgKiloPassRowState({
        data: kiloPassSummary.data,
        isError: kiloPassSummary.isError || kiloPassLinkUnavailable,
      })
    : null;
  const kiloPassManagementUrl = `${WEB_BASE_URL}/organizations/${organizationId}/subscriptions/kilo-pass`;
  const kiloPassSetupUrl = `${kiloPassManagementUrl}/setup`;
  const minimumBalance = orgWithMembers.data?.settings.minimum_balance;
  // The row shows a placeholder line, not loading copy, until the membership
  // payload supplies the value: the settled subtitle is one short phrase
  // ("Off", or the threshold sentence), so an unfinished card must not print an
  // indefinite sentence in its place.
  let lowBalanceSubtitle: string | undefined = undefined;
  if (minimumBalance != null) {
    lowBalanceSubtitle = t('organization.hub.lowBalanceBelow', {
      amount: formatMoney(minimumBalance, i18n.language),
    });
  } else if (orgWithMembers.data != null) {
    lowBalanceSubtitle = t('common.off');
  } else if (membershipUnavailable) {
    lowBalanceSubtitle = t(
      orgWithMembers.isPaused ? 'queryError.offlineTitle' : 'common.somethingWentWrong'
    );
  }
  const lowBalanceLoading = orgWithMembers.data == null && !membershipUnavailable;
  // The row names itself from the state it shows, and the name is set on every
  // state: a name handed back as `undefined` once the value lands leaves the
  // Android node announcing the value it had while loading. While loading the
  // subtitle is a Skeleton with no text, so the name carries the loading state
  // itself instead of `accessibilityState.busy`, which Android renders as the
  // node's whole content description and drops the title with it.
  const lowBalanceRetry = membershipUnavailable ? t('common.retry') : undefined;
  const lowBalanceDetail = lowBalanceSubtitle ?? t('common.loading');
  const lowBalanceAccessibilityLabel = lowBalanceRetry
    ? `${t('organization.lowBalanceAlert.title')}. ${lowBalanceDetail}. ${lowBalanceRetry}`
    : `${t('organization.lowBalanceAlert.title')}. ${lowBalanceDetail}`;

  return (
    <View className="flex-1 bg-background">
      {/* The organization name is user prose, not a UI label, so it keeps a
          second line for a natural break. The rename control sits beside it, so
          the name appears once on the screen instead of again in the card. */}
      <ScreenHeader
        title={org.organizationName}
        titleNumberOfLines={2}
        headerRight={
          showMoney ? (
            <IconButton
              onPress={() => {
                setRenameVisible(true);
              }}
              accessibilityLabel={t('organization.hub.renameTitle')}
            >
              <Pencil size={16} color={colors.mutedForeground} />
            </IconButton>
          ) : undefined
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)} className="rounded-lg bg-secondary px-3">
          {showMoney && (
            <KvRow
              label={t('organization.hub.balance')}
              value={
                hideOrgBalance
                  ? HIDDEN_BALANCE
                  : formatMoney(fromMicrodollars(org.balance), i18n.language)
              }
              valueFace="numeric"
              // An empty balance offers the top-up on the amount's own line: a
              // row of its own would hold nothing but this control.
              trailing={
                org.balance === 0 ? (
                  <AddCreditsRow
                    inline
                    url={`${WEB_BASE_URL}/organizations/${organizationId}/payment-details`}
                  />
                ) : undefined
              }
              // Always pass the label: a node React Native stops handing a
              // label keeps its previous native value on Android, so a
              // masked row that reveals its amount would still announce
              // "Balance hidden" (the credits card's own note).
              valueAccessibilityLabel={
                hideOrgBalance
                  ? t('profile.balanceHidden')
                  : formatMoney(fromMicrodollars(org.balance), i18n.language)
              }
            />
          )}
          <KvRow
            label={t('organization.hub.organizationSeats')}
            // `requireSeats` is the enforcement switch; total is the raw
            // purchased capacity and can legitimately be zero.
            value={
              org.requireSeats
                ? isolateLtrBidiText(
                    `${formatNumber(org.seatCount.used, i18n.language)} / ${formatNumber(
                      org.seatCount.total,
                      i18n.language
                    )}`
                  )
                : formatNumber(org.seatCount.used, i18n.language)
            }
            valueFace="numeric"
            last
          />
        </Animated.View>

        <OrgUsageStats organizationId={organizationId} />

        <View className="rounded-lg bg-secondary px-3">
          <ConfigureRow
            icon={Users}
            title={t('organization.members.title')}
            last={!showMoney}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/organization/members' as Href);
            }}
          />
          {showMoney && (
            <>
              <ConfigureRow
                icon={Receipt}
                title={t('organization.creditActivity.title')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/credit-activity' as Href);
                }}
              />
              <ConfigureRow
                icon={FileText}
                title={t('organization.invoices.title')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/invoices' as Href);
                }}
              />
              {kiloPassRowState != null && (
                <OrgKiloPassRow
                  state={kiloPassRowState}
                  onManage={() => {
                    void openExternalUrl(kiloPassManagementUrl, {
                      label: t('kiloPass.kiloPassManagement'),
                    });
                  }}
                  onSetup={() => {
                    void openExternalUrl(kiloPassSetupUrl, {
                      label: t('kiloPass.kiloPassSetup'),
                    });
                  }}
                  onRetry={() => {
                    // While the link is unknown the summary never fired, so the
                    // retry asks the payload that decides whether it should.
                    if (kiloPassLinkUnavailable) {
                      void orgWithMembers.refetch();
                      return;
                    }
                    void kiloPassSummary.refetch();
                  }}
                />
              )}
              <ConfigureRow
                icon={Bell}
                title={t('organization.lowBalanceAlert.title')}
                subtitle={lowBalanceSubtitle}
                subtitlePlaceholder={
                  lowBalanceLoading ? (
                    <Skeleton className="mt-0.5 h-4 w-12 rounded bg-muted-soft" />
                  ) : undefined
                }
                accessibilityLabel={lowBalanceAccessibilityLabel}
                trailing={
                  membershipUnavailable ? (
                    <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
                  ) : undefined
                }
                onPress={() => {
                  if (membershipUnavailable) {
                    void orgWithMembers.refetch();
                    return;
                  }
                  router.push('/(app)/(tabs)/(3_profile)/organization/low-balance-alert' as Href);
                }}
              />
              <ConfigureRow
                icon={Wallet}
                title={t('notifications.channel.spend')}
                last
                onPress={() => {
                  router.push(
                    `/(app)/(tabs)/(3_profile)/spend-alerts?org=${organizationId}` as Href
                  );
                }}
              />
            </>
          )}
        </View>
      </TabScreenScrollView>

      {renameVisible && (
        <RenameModal
          title={t('organization.hub.renameTitle')}
          placeholder={t('organization.hub.renamePlaceholder')}
          initialValue={org.organizationName}
          // The server validates a rename with `OrganizationNameSchema`
          // (packages/web-shared), so the field must accept the name it would
          // accept. RenameModal's own default is lower than a stored name can
          // be, and React Native applies `maxLength` to the seeded value: the
          // dialog would open on a cut name, and saving would store the cut.
          maxLength={ORGANIZATION_NAME_MAX_LENGTH}
          onSave={async name => {
            await mutations.rename.mutateAsync({ name });
            notificationHaptic(Haptics.NotificationFeedbackType.Success);
          }}
          onClose={() => {
            setRenameVisible(false);
          }}
          errorCopy={organizationErrorMessage}
        />
      )}
    </View>
  );
}

type OrgKiloPassRowProps = Readonly<{
  state: OrgKiloPassRowState;
  onManage: () => void;
  onSetup: () => void;
  onRetry: () => void;
}>;

/**
 * Compact Kilo Pass for Orgs row in the billing configuration group. Mirrors
 * ConfigureRow's layout and divider, but renders KiloPassIcon directly (it is
 * a plain function component, not a LucideIcon) and sets explicit
 * accessibility roles/labels for the manage, setup, and retry actions. Never
 * the last row — "Low balance alert" always follows it — so the divider is
 * permanent. Its icon tile follows ConfigureRow's rule too: the shared neutral
 * tile unless the state needs attention (warn), never a hue hashed from the
 * title.
 */
function OrgKiloPassRow({ state, onManage, onSetup, onRetry }: OrgKiloPassRowProps) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const tint: Tint = state.attention ? toneColor('warn') : NEUTRAL_TINT;
  let onPress: (() => void) | null = null;
  if (state.action === 'manage') {
    onPress = onManage;
  } else if (state.action === 'setup') {
    onPress = onSetup;
  } else if (state.action === 'retry') {
    onPress = onRetry;
  }
  // Every settled state of this row but the retryable error opens the Kilo Pass
  // management page on the web. The unresolved status (`action: 'none'`, shown
  // while the summary query is in flight) keeps that chevron too: it lasts one
  // request, and a momentary row without it reads as broken beside the rows
  // above and below it.
  const showsChevron = state.action !== 'retry';
  const accessibilityLabel = state.actionLabel
    ? `${t('kiloPass.title')}. ${state.subtitle}. ${state.actionLabel}`
    : `${t('kiloPass.title')}. ${state.subtitle}`;

  const inner = (
    <View className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft py-3">
      <View
        className={cn(
          'h-[30px] w-[30px] items-center justify-center rounded-lg border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <KiloPassIcon size={16} color={colors[tint.hueThemeKey]} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{t('kiloPass.title')}</Text>
        {/* `h-4` is the `text-xs` line box (1 rem; native rem is 14), so the row
            keeps its height and this title its place while the status loads; a
            shorter bar drops the text block below the 30dp icon tile and the
            whole row with it. The bar is `bg-muted-soft` because the theme's
            `bg-muted` equals the `bg-secondary` card it sits on, which drew no
            bar at all. The subtitle keeps the theme's own `line-height` rather
            than a fixed one, so it still grows with the system text scale. */}
        {state.loading ? (
          <Skeleton className="mt-0.5 h-4 w-28 rounded bg-muted-soft" />
        ) : (
          <Text className="mt-0.5 text-xs text-muted-foreground">{state.subtitle}</Text>
        )}
      </View>
      {state.action === 'retry' ? (
        <Text className="shrink-0 text-xs font-medium text-primary">{state.actionLabel}</Text>
      ) : null}
      {showsChevron ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null}
    </View>
  );

  if (onPress == null) {
    return (
      <View accessibilityLabel={accessibilityLabel} accessibilityState={{ busy: state.loading }}>
        {inner}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={state.accessibilityHint ?? undefined}
      className="active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
