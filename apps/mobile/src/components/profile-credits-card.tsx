import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { Eye, EyeOff } from '@/components/ui/icons';
import { Pressable, ScrollView, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { AddCreditsRow } from '@/components/add-credits-row';
import { BalanceBlock, type BalanceBlockState } from '@/components/profile-balance-block';
import { CreditExpiryNote } from '@/components/credits/credit-expiry-note';
import { PersonalCreditsLinks } from '@/components/credits/credits-links';
import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { SectionHeader } from '@/components/ui/section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { organizationBillingUrl } from '@/lib/credits/add-credits-destination';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatPrefixedMoney } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isMoneyRole, type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useOrganization } from '@/lib/organization-context';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { cn } from '@/lib/utils';

type CreditsCardProps = {
  readonly enabled: boolean;
  orgs: OrgListEntry[] | undefined;
};

/**
 * The amount's own line direction: a currency figure keeps its
 * left-to-right order in a right-to-left interface, so the symbol stays in
 * front of the number instead of moving behind it.
 */
const AMOUNT_DIRECTION = { direction: 'ltr', writingDirection: 'ltr' } as const;

export function CreditsCard({ enabled, orgs }: Readonly<CreditsCardProps>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const router = useRouter();
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
  const { t, i18n } = useTranslation();
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
  // One amount for the painted value and its spoken label: a label that stops
  // being passed keeps its old native value, so the shown amount would
  // otherwise still be announced as the hidden one.
  //
  // The symbol leads the number whatever the app language's own money pattern
  // says: a right-to-left locale puts the currency after the amount behind a
  // no-break space ("0.00 $"), so the same balance read as a different figure
  // in that cell than the "$0.00" the other cells show (design review, Profile
  // rtl cell, 2026-11-07). The digits and their separators still come from the
  // locale's number formatter, and the formatter's own minus sign stays in
  // front of the symbol: a balance can be negative, and "-$5.00" is the
  // figure a reader expects, not "$-5.00".
  const amountText = formatPrefixedMoney(balanceDollars, i18n.language);
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
          hiddenAmount={hideBalance || !hideBalanceLoaded ? HIDDEN_BALANCE : undefined}
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
        variant="figure"
        // A reader compares the amount digit by digit, and its symbol is
        // neutral to the line's direction, so the run keeps its own
        // left-to-right order whatever the interface language.
        style={AMOUNT_DIRECTION}
        accessibilityLabel={hideBalance ? t('profile.balanceHidden') : amountText}
      >
        {hideBalance ? HIDDEN_BALANCE : amountText}
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

  // An organization's top-up is the external billing page, so it carries the
  // row's App Store gate and opens for a member who can manage billing. The
  // personal purchase is this section's header action, so it never drops to a
  // row of its own in a narrow card.
  const orgAddCreditsAction =
    selectedOrgId != null && canManageOrgBilling ? (
      <AddCreditsRow url={organizationBillingUrl(selectedOrgId)} inline={stackBalance} />
    ) : null;

  const addCreditsAction = selectedOrgId == null ? null : orgAddCreditsAction;

  // The balance slot's state: one shell paints all three, so the card never
  // moves as the read answers, fails or retries.
  let balanceState: BalanceBlockState = 'ready';
  if (showBalanceSkeleton) {
    balanceState = 'loading';
  } else if (balanceFailed) {
    balanceState = 'failed';
  }

  const retryBalance = () => {
    refetchUserId();
    void refetchBalance();
  };

  return (
    <View
      className="gap-3"
      onLayout={event => {
        setAvailableWidth(event.nativeEvent.layout.width);
      }}
    >
      <SectionHeader
        label={t('profile.credits')}
        reserveLabelAir
        actionLabel={selectedOrgId == null ? t('addCredits.cta') : undefined}
        onActionPress={
          selectedOrgId == null
            ? () => {
                router.push('/(app)/credits' as Href);
              }
            : undefined
        }
      />
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

      <BalanceBlock
        state={balanceState}
        stacked={stackBalance}
        amount={amountLine}
        toggle={visibilityToggle}
        note={expirySlot}
        failureLabel={t('profile.balanceLoadFailed')}
        action={addCreditsAction}
        retryLabel={t('profile.failedToLoadBalance')}
        retryActionLabel={t('common.retry')}
        onRetry={retryBalance}
      />
      {/* The person's own history and invoices sit under their balance; an
          organization's balance has no personal rows, so only the personal
          selection carries them. */}
      {selectedOrgId == null && <PersonalCreditsLinks />}
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
