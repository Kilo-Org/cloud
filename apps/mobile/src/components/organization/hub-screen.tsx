/* eslint-disable max-lines -- The hub composes every organization row (money, members, Kilo Pass, rename) on one screen. */
import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { hasVisibleText } from '@kilocode/app-shared/text';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import {
  Bell,
  CreditCard,
  FileText,
  Pencil,
  Plug,
  Receipt,
  Users,
  Wallet,
} from '@/components/ui/icons';
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
import {
  visibleInAppSettingsRows,
  visibleOrgSettingsRows,
} from '@/components/organization/organization-settings-rows';
import { OrganizationPlanRefusal } from '@/components/organization/plan-refusal';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { IconButton } from '@/components/ui/icon-button';
import { IconTile } from '@/components/ui/icon-tile';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';
import { i18n } from '@/i18n';
import { NEUTRAL_TINT, type Tint, toneColor } from '@/lib/agent-color';
import { openAppShellHandoff } from '@/lib/app-shell-handoff';
import { isolateLtrBidiText } from '@/lib/bidi';
import { useCanLinkExternalPurchase } from '@/lib/billing/external-purchase-link';
import { seatCountReadout } from '@/components/organization/billing-model';
import { WEB_BASE_URL } from '@/lib/config';
import { organizationBillingUrl } from '@/lib/credits/add-credits-destination';
import { openExternalUrl } from '@/lib/external-link';
import { formatPrefixedMoney } from '@/lib/format';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgKiloPassSummary,
  useOrgParentLink,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { billingHrefFor } from '@/lib/trial-refusal';

type OrganizationHubScreenProps = Readonly<{
  /** Explicit org id from a deep link (e.g. /organizations/<id>/overview). */
  organizationIdOverride?: string;
}>;

/** Whether the rename control offers the dialog, or only says it cannot. */
type RenameControl = { kind: 'ready'; onPress: () => void } | { kind: 'blocked' };

/**
 * The rename control's props for its state. A blocked control keeps the same
 * box and therefore the same header width: the title beside it cannot reflow to
 * another line. It is dimmed and disabled the way the shared Button dims a
 * disabled non-primary control, and it states nothing beyond its own name: the
 * plan refusal block below the header states the reason once, so a label that
 * repeated it would have the screen reader speak the sentence twice in a row.
 * A hint is no place for it either: React Native maps `accessibilityHint` to the
 * platform's tooltip text, which TalkBack does not announce with the node.
 */
function renameControlProps(control: RenameControl, label: string) {
  if (control.kind === 'ready') {
    return { accessibilityLabel: label, onPress: control.onPress };
  }
  return {
    disabled: true,
    className: 'opacity-50',
    accessibilityLabel: label,
    accessibilityState: { disabled: true },
  };
}

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

  // `organizations.list` carries the org's parent link, so the billing group
  // knows from its first frame whether this org has a Kilo Pass row instead of
  // adding one a request later and pushing the rows under it down. The hook
  // reconciles that cached entry with the membership payload.
  const {
    membership: orgWithMembers,
    parentLink,
    membershipUnavailable,
  } = useOrgParentLink(organizationId, org?.parentOrganizationId);
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
  // The storefront rule that decides whether the plan-ended banner may link to
  // the web billing page. Read with the other hooks, before the boundary's
  // early return.
  const canLinkBilling = useCanLinkExternalPurchase();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const [renameVisible, setRenameVisible] = useState(false);
  const { t } = useTranslation();
  // The same preference the Profile credits card obeys. Until the disk read
  // settles the choice is unknown, so the amount stays masked: the hub must
  // never paint an amount the person may have hidden one screen away.
  const { hideBalance, hasLoaded: hideBalanceLoaded } = useHideBalancePreference();
  const hideOrgBalance = hideBalance || !hideBalanceLoaded;
  // Reactive offline wording: a read that settled by failing while the device
  // is confirmed offline names the connection, not a server fault.
  const committedConnectivity = useCommittedConnectivityStatus();

  if (isResolving || organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('common.organization')}
        backFallback={PROFILE_TAB_HREF}
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
  const minimumBalance = orgWithMembers.data?.settings.minimum_balance;
  // The row shows a placeholder line, not loading copy, until the membership
  // payload supplies the value: the settled subtitle is one short phrase
  // ("Off", or the threshold sentence), so an unfinished card must not print an
  // indefinite sentence in its place.
  let lowBalanceSubtitle: string | undefined = undefined;
  if (minimumBalance != null) {
    lowBalanceSubtitle = t('organization.hub.lowBalanceBelow', {
      amount: isolateLtrBidiText(formatPrefixedMoney(minimumBalance, i18n.language)),
    });
  } else if (orgWithMembers.data != null) {
    lowBalanceSubtitle = t('common.off');
  } else if (membershipUnavailable) {
    // The membership read settles offline too (`SETTLE_WHILE_OFFLINE`), so the
    // offline wording reads from the committed connectivity state, the same
    // source the offline banner paints — `isPaused` can no longer distinguish
    // a device-window offline read.
    lowBalanceSubtitle = t(
      committedConnectivity === 'offline' ? 'queryError.offlineTitle' : 'common.somethingWentWrong'
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

  // One string for the painted balance and its spoken label, in the shape the
  // Profile credits card paints the same balance.
  const balanceAmount = formatPrefixedMoney(fromMicrodollars(org.balance), i18n.language);
  // The plan and the subscription gate's own verdict arrive on the same
  // membership row that decides whether this screen renders at all, so both
  // paint settled on the first frame: there is no plan loading or plan error
  // state to reserve room for, and a refetch that fails keeps the last verdict
  // exactly as it does for the new-session composer. Only the server's boolean
  // is read; nothing re-derives the plan state from seats or balance.
  const planEnded = org.isTrialExpiredForEnforcement;
  const planName =
    org.plan === 'enterprise'
      ? t('organization.hub.planEnterprise')
      : t('organization.hub.planTeams');
  const planBillingUrl = `${WEB_BASE_URL}/organizations/${organizationId}/subscriptions`;
  // A money role whose platform may open the billing page gets the state
  // alone, because the banner's action is the next step. A money role the
  // storefront rule keeps from linking gets the sentence the rest of the app
  // shows, which names where billing is changed, exactly as a role that cannot
  // change the plan does: with no action, the sentence has to carry the step.
  const planMessage =
    showMoney && canLinkBilling
      ? t('organization.hub.planEnded')
      : t('common.organizationTrialEnded');

  // The rename control's two states. `organizations.update` runs on the
  // organization billing mutation procedure, which refuses every mutation once
  // `classifyOrganizationEntitlement` reports the hard-expired trial, and that is
  // the same server verdict `planEnded` reads. A lapsed plan therefore disables
  // the control instead of opening a field whose save cannot succeed, and the
  // refusal block below the header states why.
  const renameControl: RenameControl = planEnded
    ? { kind: 'blocked' }
    : {
        kind: 'ready',
        onPress: () => {
          setRenameVisible(true);
        },
      };

  // The in-app destinations the hub opens itself. The audit log's gate reads
  // only the role and the plan, which the organization row decides before this
  // screen renders; the guardrails row also needs the organization's Kilo
  // Encrypt setting, so it arrives with the membership payload — the same
  // commit that paints the web group below it, so nothing already on screen
  // moves when it lands.
  const inAppSettingsRows = visibleInAppSettingsRows(
    {
      role,
      plan: org.plan,
      guardrailsEnabled: orgWithMembers.data?.settings.kilo_encrypt,
    },
    organizationId
  );

  // The organization dashboard's own settings on the web, one row per area.
  // The group waits for the membership payload because the guardrails row in
  // the card above arrives with it: painting the group on the cached list
  // entry's absence and moving it a request later would shift every row in it.
  // It is the last group on the screen, so its arrival pushes nothing above it.
  const settingsRows =
    orgWithMembers.data == null && !membershipUnavailable
      ? null
      : visibleOrgSettingsRows({ plan: org.plan }, organizationId);

  return (
    <View className="flex-1 bg-background">
      {/* The organization name is user prose, not a UI label, so it keeps a
          second line for a natural break. The rename control sits beside it, so
          the name appears once on the screen instead of again in the card. */}
      <ScreenHeader
        title={org.organizationName}
        titleNumberOfLines={2}
        backFallback={PROFILE_TAB_HREF}
        headerRight={
          showMoney ? (
            <IconButton {...renameControlProps(renameControl, t('organization.hub.renameTitle'))}>
              <Pencil size={16} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {/* A lapsed plan blocks every new session for every member of this
            organization, so it is stated before the numbers the screen opens
            on. Only a billing role gets the action, because the web billing
            page refuses the other roles; the sentence then stops at the state
            so it does not restate the control below it, while a role without
            the action keeps the next step in the sentence. The plan row inside
            the card below states the tier and its status, so this block adds
            neither. */}
        {planEnded ? (
          <OrganizationPlanRefusal
            message={planMessage}
            action={
              showMoney && canLinkBilling
                ? {
                    label: t('organization.hub.manageBilling'),
                    onPress: () => {
                      void openExternalUrl(planBillingUrl, {
                        label: t('organization.hub.manageBilling'),
                      });
                    },
                  }
                : undefined
            }
          />
        ) : null}
        <Animated.View entering={FadeIn.duration(200)}>
          <RowGroup>
            {showMoney && (
              <KvRow
                label={t('organization.hub.balance')}
                value={hideOrgBalance ? HIDDEN_BALANCE : balanceAmount}
                valueFace="numeric"
                // The amount's symbol and sign are neutral to the paragraph's
                // direction, so the run carries its own left-to-right order.
                valueDirection="ltr"
                // An empty balance offers the top-up on the amount's own line: a
                // row of its own would hold nothing but this control, and
                // `lineAction` keeps that line one text line tall. Only painted
                // where the platform may open the page (`canLinkBilling`),
                // because the control's label alone beside the amount reads as
                // part of it, and the Billing row below carries the destination
                // on a platform that cannot link.
                trailing={
                  org.balance === 0 && canLinkBilling ? (
                    <AddCreditsRow inline lineAction url={organizationBillingUrl(organizationId)} />
                  ) : undefined
                }
                // Always pass the label: a node React Native stops handing a
                // label keeps its previous native value on Android, so a
                // masked row that reveals its amount would still announce
                // "Balance hidden" (the credits card's own note).
                valueAccessibilityLabel={
                  hideOrgBalance ? t('profile.balanceHidden') : balanceAmount
                }
              />
            )}
            <KvRow
              label={t('organization.hub.organizationSeats')}
              // `requireSeats` is the enforcement switch; total is the raw
              // purchased capacity and can legitimately be zero, so the shared
              // readout prints the used count alone until seats were bought.
              value={seatCountReadout({
                seatsEnforced: org.requireSeats,
                used: org.seatCount.used,
                total: org.seatCount.total,
              })}
              valueFace="numeric"
            />
            {/* The plan is the tier the seats belong to, so it closes the card
              the seats are counted in and paints in every state. A lapsed plan
              states that in this row: the tier alone beside the block above
              would read as an active plan, and the tier keeps the row's own ink
              so only the state carries the warning. */}
            <KvRow
              label={t('organization.hub.plan')}
              value={planName}
              valueStatus={
                planEnded
                  ? { label: t('organization.hub.planStatusLapsed'), tone: 'danger' }
                  : undefined
              }
              valueFace="text"
            />
          </RowGroup>
        </Animated.View>

        <OrgUsageStats
          organizationId={organizationId}
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/organization/usage' as Href);
          }}
        />

        <RowGroup leadingTile>
          <ConfigureRow
            icon={Users}
            title={t('organization.members.title')}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/organization/members' as Href);
            }}
          />
          {/* Every member may view the organization's connections; the hub
              itself hides the actions their role cannot take. */}
          <ConfigureRow
            icon={Plug}
            title={t('integrations.title')}
            onPress={() => {
              router.push(`/(app)/(tabs)/(3_profile)/integrations?org=${organizationId}` as Href);
            }}
          />
          {showMoney && (
            <ConfigureRow
              icon={CreditCard}
              title={t('organization.billing.title')}
              onPress={() => {
                router.push(billingHrefFor(organizationId));
              }}
            />
          )}
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
                onPress={() => {
                  router.push(
                    `/(app)/(tabs)/(3_profile)/spend-alerts?org=${organizationId}` as Href
                  );
                }}
              />
            </>
          )}
          {/* The destinations this app reads and writes itself. They close the
              card — see `visibleInAppSettingsRows`. */}
          {inAppSettingsRows.map(row => (
            <ConfigureRow
              key={row.area}
              icon={row.icon}
              title={row.title}
              onPress={() => {
                router.push(row.href);
              }}
            />
          ))}
        </RowGroup>

        {/* The areas this app does not reimplement. Each row opens the page
            that already owns the setting, and the row set follows the web
            sidebar's role and plan gates — see `visibleOrgSettingsRows`. A role
            the gates leave with no destination paints no heading: the group is
            the only place they were listed, so an empty one would name nothing. */}
        {settingsRows == null || settingsRows.length === 0 ? null : (
          <Section label={t('organization.settingsOnWeb.title')}>
            <RowGroup leadingTile>
              {settingsRows.map(row => (
                <ConfigureRow
                  key={row.area}
                  icon={row.icon}
                  title={row.title}
                  onPress={() => {
                    if (row.target.kind === 'app-shell') {
                      void openAppShellHandoff(row.target.target, { label: row.title });
                      return;
                    }
                    void openExternalUrl(row.target.url, { label: row.title });
                  }}
                />
              ))}
            </RowGroup>
          </Section>
        )}
      </TabScreenScrollView>

      {renameVisible && (
        <RenameModal
          title={t('organization.hub.renameTitle')}
          placeholder={t('organization.hub.renamePlaceholder')}
          initialValue={org.organizationName}
          // The server validates a rename with `OrganizationNameSchema`
          // (packages/web-shared), so the field must accept the name it would
          // accept, and it refuses a name the server's visible-character rule
          // refuses. RenameModal's own default is lower than a stored name can
          // be, and React Native applies `maxLength` to the seeded value: the
          // dialog would open on a cut name, and saving would store the cut.
          maxLength={ORGANIZATION_NAME_MAX_LENGTH}
          isAcceptableValue={hasVisibleText}
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
  onRetry: () => void;
}>;

/**
 * Compact Kilo Pass for Orgs row in the billing configuration group. Mirrors
 * ConfigureRow's layout and divider, but renders KiloPassIcon directly (it is
 * a plain function component, not a LucideIcon) and sets an explicit
 * accessibility role and label for the one action it can offer, the retry.
 * Never the last row — "Low balance alert" always follows it — so the divider
 * is permanent. Its icon tile follows ConfigureRow's rule too: the shared
 * neutral tile unless the state needs attention (warn), never a hue hashed from
 * the title.
 *
 * The row opens nothing else: Kilo Pass is no longer sold in either store, so
 * it has no setup or management page to send the reader to and carries no
 * chevron.
 */
function OrgKiloPassRow({ state, onRetry }: OrgKiloPassRowProps) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const tint: Tint = state.attention ? toneColor('warn') : NEUTRAL_TINT;
  const onPress = state.action === 'retry' ? onRetry : null;
  const accessibilityLabel = state.actionLabel
    ? `${t('kiloPass.title')}. ${state.subtitle}. ${state.actionLabel}`
    : `${t('kiloPass.title')}. ${state.subtitle}`;

  const inner = (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
      <IconTile tint={tint} content={<KiloPassIcon size={16} color={colors[tint.hueThemeKey]} />} />
      <View className="min-w-0 flex-1">
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
