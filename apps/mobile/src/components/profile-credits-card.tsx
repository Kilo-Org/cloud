import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { ChevronDown, Eye, EyeOff } from '@/components/ui/icons';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { AddCreditsButton, AddCreditsRow } from '@/components/add-credits-row';
import { useContextPicker } from '@/components/context-control';
import { CreditExpiryNote } from '@/components/credits/credit-expiry-note';
import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatMoney } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isMoneyRole, type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { useOrganization } from '@/lib/organization-context';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const HIDDEN_BALANCE = '*****';

type CreditsCardProps = {
  readonly enabled: boolean;
  orgs: OrgListEntry[] | undefined;
};

export function CreditsCard({ enabled, orgs }: Readonly<CreditsCardProps>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  // Stack the balance unless the expiry note keeps its two lines beside the
  // amount, the visibility toggle and the purchase action. Measured on the
  // standard matrix (Android, 2026-11-02): the note takes two lines from a
  // 215 dp column and three lines below that, and the one-row siblings take
  // 157 dp of the card, so the one-row layout holds from about 372 scaled card
  // dp. The threshold stacks below 370 of them and uses the card's width rather
  // than the display's; below it the note takes a row of its own at full width.
  const stackBalance = availableWidth === null || availableWidth / fontScale < 370;
  // Below NARROW_LAYOUT_WIDTH the account picker's 65% share leaves the
  // "CREDITS" eyebrow too little room for one word and Android breaks it
  // mid-word ("CREDIT S", 160 dp, e1, 2026-09-21). Stacking gives each line the
  // row's full width.
  const narrow = isNarrowLayout(width);
  const { t, i18n } = useTranslation();
  const { openPicker, picker } = useContextPicker(orgs);
  const { organizationId, error, isSaving, retry } = useOrganization();
  const selectedOrgId = organizationId ?? undefined;

  const { hideBalance, hasLoaded: hideBalanceLoaded, setHideBalance } = useHideBalancePreference();
  const { userId, isError: userIdError, refetch: refetchUserId } = useCurrentUserId({ enabled });
  const hasUserId = userId !== undefined;

  const balanceOptions = trpc.user.getContextBalance.queryOptions({
    organizationId: selectedOrgId,
  });

  // tRPC v11 `isPrefixedQueryKey` misreads a 3-element query key (e.g. one
  // suffixed with the userId) as `[prefix, path, args]` and makes the queryFn
  // throw `path.join is not a function` before any network request. Keep the
  // raw 2-element key and fail fast if it ever regresses.
  if (balanceOptions.queryKey.length !== 2) {
    throw new Error('getContextBalance query key must stay 2-element ([path, input])');
  }
  const personalCreditOptions = trpc.user.getCreditBlocks.queryOptions({});
  const orgCreditOptions = trpc.organizations.getCreditBlocks.queryOptions({
    organizationId: selectedOrgId ?? '',
  });

  const {
    data: balance,
    isLoading: balanceLoading,
    isPlaceholderData: balancePlaceholder,
    isError: balanceQueryError,
    refetch: refetchBalance,
  } = useQuery({
    ...balanceOptions,
    enabled: enabled && hasUserId,
    placeholderData: keepPreviousData,
    // A paused read left the balance skeleton with no exit.
    ...SETTLE_WHILE_OFFLINE,
  });

  const { data: personalCreditData, isError: personalCreditsError } = useQuery({
    ...personalCreditOptions,
    enabled: enabled && hasUserId && !selectedOrgId,
    ...SETTLE_WHILE_OFFLINE,
  });

  const {
    data: orgCreditData,
    isError: orgCreditsError,
    isPlaceholderData: orgCreditsPlaceholder,
  } = useQuery({
    ...orgCreditOptions,
    enabled: enabled && hasUserId && Boolean(selectedOrgId),
    placeholderData: keepPreviousData,
    ...SETTLE_WHILE_OFFLINE,
  });

  // A failed getMe (no userId) can never render a trusted balance, so it shares
  // the balance error surface. Retry re-resolves the owner and re-fetches.
  const balanceFailed = balanceQueryError || userIdError;

  const creditData = selectedOrgId ? orgCreditData : personalCreditData;
  const creditsFailed = selectedOrgId ? orgCreditsError : personalCreditsError;
  const creditsPending =
    creditData === undefined || (Boolean(selectedOrgId) && orgCreditsPlaceholder);

  const balanceDollars = balance?.balance ?? 0;
  // One formatted amount for the painted value and its spoken label: a label
  // that stops being passed keeps its old native value, so the shown amount
  // would otherwise still be announced as the hidden one.
  const balanceText = formatMoney(balanceDollars, i18n.language);
  // A read that has not answered yet is pending without fetching while the
  // owner is still unresolved (the balance query is gated on the identity), so
  // `balanceLoading` (isLoading) is false while `balance` is still undefined.
  // Treat "no data yet" as loading so the card shows a skeleton instead of `$0`
  // on a cold launch. The read itself settles regardless of the online manager,
  // and an unreachable one lands on `balanceFailed` instead of this branch.
  const balancePending = balance === undefined && !balanceFailed;
  // `keepPreviousData` keeps the last account's amount on screen while the next
  // account's read runs, which would paint the previous account's balance under
  // the newly selected account's name with no cue at all. The skeleton owns that
  // window too, so a context switch never shows an amount that belongs to
  // another account; the read either answers or lands on `balanceFailed`.
  const showBalanceSkeleton =
    (balanceLoading || balancePending || balancePlaceholder || !hideBalanceLoaded) &&
    !balanceFailed;

  const selectedLabel = selectedOrgId
    ? (orgs?.find(o => o.organizationId === selectedOrgId)?.organizationName ??
      t('common.organization'))
    : t('common.personal');

  const canPickContext = orgs !== undefined;

  // Personal credits are a consumable bought in-app, so the personal row is
  // shown on every platform and at any balance — a funded user must still be
  // able to top up. Org billing stays a web flow and only members who can
  // manage billing see the external CTA, matching the money-role gate on the
  // organization hub screen.
  const selectedOrgRole = orgs?.find(o => o.organizationId === selectedOrgId)?.role;
  const canManageOrgBilling = selectedOrgId != null && isMoneyRole(selectedOrgRole);

  // The expiry note's slot: under the amount. No entrance fade — the caption
  // holds a row of this block, so a fade that paints it late leaves it empty.
  const expirySlot = (
    <>
      {creditsFailed && (
        <Text className="text-xs text-muted-foreground">{t('credits.expiryUnavailable')}</Text>
      )}
      {!creditsFailed && creditsPending && (
        <Skeleton className="h-3 w-40 max-w-full rounded bg-muted-soft" />
      )}
      {!creditsFailed && !creditsPending && (
        <CreditExpiryNote
          creditBlocks={creditData.creditBlocks}
          hiddenAmount={hideBalance ? HIDDEN_BALANCE : undefined}
          emptyMessage={t('credits.noExpiringCredits')}
        />
      )}
    </>
  );

  // `shrink-0 grow-0` keeps the amount at its text height: a horizontal
  // ScrollView defaults to `flexGrow: 1`, so inside a column it would take the
  // spare height and push the note away from the amount.
  const amountLine = (
    <ScrollView horizontal className="min-w-0 shrink-0 grow-0">
      <Text
        className="text-2xl font-bold tabular-nums"
        accessibilityLabel={hideBalance ? t('profile.balanceHidden') : balanceText}
      >
        {hideBalance ? HIDDEN_BALANCE : balanceText}
      </Text>
    </ScrollView>
  );

  const visibilityToggle = (
    <Pressable
      className={cn(ICON_TARGET_BOX_CLASS, 'shrink-0 active:opacity-70')}
      onPress={() => {
        selectionHaptic();
        setHideBalance(!hideBalance);
      }}
      accessibilityRole="button"
      accessibilityLabel={hideBalance ? t('profile.showBalance') : t('profile.hideBalance')}
    >
      {hideBalance ? (
        <Eye size={18} color={colors.mutedForeground} />
      ) : (
        <EyeOff size={18} color={colors.mutedForeground} />
      )}
    </Pressable>
  );

  // The purchase action: in the trailing control column with the visibility
  // toggle. No in-progress indicator sits beside it, because this row paints a
  // balance that belongs to the selected account and a background refresh may
  // legitimately take a while or never finish. The first load and a context
  // switch own the skeleton above; a refresh that fails owns the retry surface.
  // An indicator tied to every in-flight refresh spun for as long as a stalled
  // one lasted (and announced itself as "In progress").
  //
  // An organization's top-up is the external billing page, so it carries the
  // row's App Store gate and opens only for a member who can manage billing at
  // an empty balance. It uses the same trailing slot as the personal purchase:
  // a block of its own held nothing but the control once the copy beside it
  // left.
  const orgAddCreditsEligible =
    selectedOrgId != null &&
    canManageOrgBilling &&
    !balanceLoading &&
    !balancePending &&
    !balanceFailed &&
    balanceDollars === 0;

  let addCreditsAction: ReactNode = null;
  if (selectedOrgId == null) {
    addCreditsAction = (
      <View className="max-w-full flex-row flex-wrap items-center justify-end gap-2">
        <AddCreditsButton
          className="h-auto min-h-11 max-w-full py-2"
          onPress={() => {
            router.push('/(app)/credits' as Href);
          }}
        />
      </View>
    );
  } else if (orgAddCreditsEligible) {
    addCreditsAction = (
      <AddCreditsRow url={`${WEB_BASE_URL}/organizations/${selectedOrgId}/payment-details`} />
    );
  }

  return (
    <View
      className="gap-3"
      onLayout={event => {
        setAvailableWidth(event.nativeEvent.layout.width);
      }}
    >
      <View
        className={cn(
          'min-h-11 gap-3',
          narrow ? 'flex-col items-stretch' : 'flex-row items-center justify-between'
        )}
      >
        <Text variant="small" className="shrink uppercase tracking-wide text-muted-foreground">
          {t('profile.credits')}
        </Text>
        {canPickContext && (
          <Pressable
            className={cn(
              'min-h-11 min-w-0 flex-row items-center gap-1 active:opacity-70',
              narrow ? 'max-w-full justify-start' : 'max-w-[65%] shrink justify-end'
            )}
            onPress={openPicker}
            accessibilityRole="button"
            accessibilityLabel={selectedLabel}
            accessibilityHint={t('profile.selectAccount')}
            hitSlop={8}
          >
            <Text
              className="min-w-0 shrink text-xs font-medium text-muted-foreground"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {selectedLabel}
            </Text>
            <ChevronDown size={14} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>
      {picker}
      {error === 'save' && (
        <View>
          <AccessibleStatus message={t('common.couldNotSaveSetting')} className="text-sm" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            accessibilityHint={t('common.couldNotSaveSetting')}
            accessibilityState={{ busy: isSaving, disabled: isSaving }}
            disabled={isSaving}
            onPress={retry}
            className={cn(STATE_ACTION_CLASS, 'flex-row items-center gap-2 active:opacity-70')}
          >
            <Text className="text-sm text-primary">{t('common.retry')}</Text>
            {isSaving && <ActivityIndicator size="small" color={colors.mutedForeground} />}
          </Pressable>
        </View>
      )}

      {showBalanceSkeleton && (
        // Content-shaped skeleton (number bar + note bar in the card's own
        // bg-secondary shell): a plain block read as an empty box in the e5
        // spot check (2026-09-07). The bars are bg-muted-soft because the
        // theme's bg-muted equals bg-secondary — default-tone bars were
        // invisible in this shell (b911 e2 spot check: "blank beige block",
        // e2-nav-profile.png).
        //
        // The inner column keeps the loaded block's 48 dp content height
        // (amount line 28.19 + gap 3.5 + note line 14.1, on the 48 dp
        // visibility toggle it shares the row with), so the shell measures the
        // loaded block's 62.1 dp rather than the 56 dp its own `min-h-16` and
        // two bars made: the swap to the balance row moved every section below
        // it by 1.5 dp (design gate, Profile, 2026-11-05).
        <View className="min-h-16 flex-row items-center rounded-lg bg-secondary px-3 py-2">
          <View className="min-h-[48px] flex-1 justify-center gap-1">
            <Skeleton className="h-8 w-28 rounded-md bg-muted-soft" />
            <Skeleton className="h-3 w-40 rounded bg-muted-soft" />
          </View>
        </View>
      )}
      {balanceFailed && (
        <Pressable
          className="min-h-16 justify-center rounded-lg bg-secondary px-3 py-3 active:opacity-70"
          onPress={() => {
            refetchUserId();
            void refetchBalance();
          }}
        >
          <Text className="text-sm text-destructive">{t('profile.failedToLoadBalance')}</Text>
        </Pressable>
      )}
      {balanceFailed && selectedOrgId == null && (
        <AddCreditsButton
          onPress={() => {
            router.push('/(app)/credits' as Href);
          }}
        />
      )}
      {!showBalanceSkeleton && !balanceFailed && (
        <View
          className={cn(
            'min-h-16 gap-2 rounded-lg bg-secondary px-3 py-2',
            // A stacked card ends on the Add credits button, whose own line
            // sits inside a 38.5 dp pill. `pb-3` gives that pill more room under
            // it than the card's 7 dp top padding gives the amount above it, so
            // the bottom edge does not read as tighter than the top.
            stackBalance ? 'items-stretch pb-3' : 'flex-row items-center'
          )}
        >
          <Animated.View
            className={cn('min-w-0', stackBalance ? 'gap-1' : 'flex-1 flex-row items-center gap-1')}
            layout={LinearTransition.duration(200)}
          >
            {/* Row 1 holds the amount, and the toggle on a stacked card. Its
                48 dp box carries `-my-[10px]`, so it reaches its touch target
                without adding height: the row ends at the amount's own line and
                the note below keeps the wide cells' 3.4 dp gap. On a wide card
                the toggle is the row's sibling and the note stays in the
                amount's column. */}
            <View
              className={cn(
                'min-w-0',
                // `flex-1` is the row's width share only while this View is the
                // column's child on a wide card. On a stacked card this View is
                // the amount row inside the column, where `flex-1` sets a 0
                // vertical basis and the row measured 0 dp tall on the first
                // layout pass (Android compact cell, 2026-11-03); the card's
                // `items-stretch` already gives it the full width.
                stackBalance ? 'flex-row items-center gap-1' : 'flex-1 gap-1'
              )}
            >
              <View className={cn('min-w-0', stackBalance && 'flex-1')}>{amountLine}</View>
              {stackBalance ? (
                <View className="shrink-0 -my-[10px]">{visibilityToggle}</View>
              ) : (
                expirySlot
              )}
            </View>
            {stackBalance ? expirySlot : visibilityToggle}
          </Animated.View>
          {/* The purchase action keeps the card's trailing end in both
              layouts: the trailing column on a wide card, its own row below
              the note on a stacked one. The element owns its container, so a
              card with no action for this platform gains no empty slot. */}
          {addCreditsAction}
        </View>
      )}
      {/* One loading indicator per section: while the balance slot shows its
          skeleton, the KiloPass card reserves its slot quietly instead of
          stacking a second skeleton card. The card's queries still run from
          mount, so the swap adds no fetch latency. */}
      {enabled && !selectedOrgId ? (
        <KiloPassSubscriptionCard hideLoadingSkeleton={showBalanceSkeleton} />
      ) : null}
    </View>
  );
}
