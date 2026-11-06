import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { ChevronDown, Eye, EyeOff } from '@/components/ui/icons';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { AddCreditsButton, AddCreditsRow } from '@/components/add-credits-row';
import { useContextPicker } from '@/components/context-control';
import { CreditExpiryNote } from '@/components/credits/credit-expiry-note';
import { BalanceRow } from '@/components/credits/credits-balance-row';
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
  // Stack the balance below 370 scaled card dp; wide cells keep the note
  // beside the amount at two lines, stacked cells take it at full width.
  // Measured on the standard matrix (Android, 2026-11-02).
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

  // The expiry note's slot, under the amount. Every state reserves the note's
  // own line box — `text-xs` here is a 14 dp line — so a slot that has not
  // resolved paints that line as its bar and nothing below moves (Android base
  // cell, design gate 2026-11-06). No entrance fade: the caption holds a row
  // of this block, so a fade that paints it late leaves it empty.
  const expirySlot = (
    <>
      {creditsFailed && (
        <Text className="text-xs text-muted-foreground">{t('credits.expiryUnavailable')}</Text>
      )}
      {!creditsFailed && creditsPending && (
        <Skeleton className="h-[14px] w-40 max-w-full rounded bg-muted-soft" />
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
  const addCreditsAction =
    selectedOrgId == null ? (
      <AddCreditsButton
        className="h-auto min-h-11 max-w-full py-2"
        onPress={() => {
          router.push('/(app)/credits' as Href);
        }}
      />
    ) : null;

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
        // spot check (2026-09-07). It holds the balance row's own height: the
        // column converges on the row's p-2 column (number line + gap + note
        // line) and the reserved control box matches the row's 48 dp toggle,
        // which is what sets that row's height. A shorter placeholder left the
        // sections below moving by the difference when the row arrived (Android
        // base cell, design gate 2026-11-06). The bars are bg-muted-soft
        // because the theme's bg-muted equals bg-secondary — default-tone bars
        // were invisible in this shell (b911 e2 spot check: "blank beige
        // block", e2-nav-profile.png).
        <View className="min-h-16 flex-row items-center rounded-lg bg-secondary px-3 py-2">
          <View className="min-h-12 flex-1 justify-center gap-1">
            <Skeleton className="h-7 w-28 rounded-md bg-muted-soft" />
            <Skeleton className="h-[14px] w-40 rounded bg-muted-soft" />
          </View>
          <View className="h-12 w-12 shrink-0" />
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
        <BalanceRow
          stackBalance={stackBalance}
          amountLine={amountLine}
          visibilityToggle={visibilityToggle}
          expirySlot={expirySlot}
          addCreditsAction={addCreditsAction}
        />
      )}
      {selectedOrgId != null &&
        canManageOrgBilling &&
        !balanceLoading &&
        !balancePending &&
        !balanceFailed &&
        balanceDollars === 0 && (
          <AddCreditsRow
            url={`${WEB_BASE_URL}/organizations/${selectedOrgId}/payment-details`}
            className="rounded-lg bg-secondary px-3 py-3"
          />
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
