import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { selectionHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { Eye, EyeOff } from '@/components/ui/icons';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { BalanceBlock, type BalanceBlockState } from '@/components/profile-balance-block';
import { CreditExpiryNote } from '@/components/credits/credit-expiry-note';
import { PersonalCreditsLinks } from '@/components/credits/credits-links';
import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { SectionHeader } from '@/components/ui/section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useCanLinkExternalPurchase } from '@/lib/billing/external-purchase-link';
import { organizationBillingUrl } from '@/lib/credits/add-credits-destination';
import { openExternalUrl } from '@/lib/external-link';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatPrefixedMoney } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useHideBalancePreference } from '@/lib/hooks/use-hide-balance-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_GUTTER_DP } from '@/lib/layout';
import { useStyleSideInsets } from '@/lib/screen-insets';
import { isMoneyRole, type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useOrganization } from '@/lib/organization-context';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import {
  classifyReadFailureKind,
  readFailureKindIsRetryable,
} from '@/lib/query/read-failure-variant';
import { useTRPC } from '@/lib/trpc';
import { HIDDEN_BALANCE } from '@/lib/storage-keys';
import { cn } from '@/lib/utils';

/**
 * The memberships the Profile screen's `organizations.list` read stands in.
 * The card needs them for one thing: a money role's own balance. That cannot
 * come from `getContextBalance`, which answers `$0.00` for a
 * `billing_manager`, so an `undefined` list would paint a money role's
 * organization as empty. Keeping "not answered yet" and "could not load" apart
 * lets the card hold its skeleton and its retry surface apart too.
 */
export type CreditsCardOrgList =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | { status: 'ready'; orgs: OrgListEntry[] };

type CreditsCardProps = {
  readonly enabled: boolean;
  readonly orgList: CreditsCardOrgList;
};

/**
 * The amount's own line direction: a currency figure keeps its
 * left-to-right order in a right-to-left interface, so the symbol stays in
 * front of the number instead of moving behind it.
 */
const AMOUNT_DIRECTION = { direction: 'ltr', writingDirection: 'ltr' } as const;

/**
 * One `caption` line at font scale 1. `text-xs` lays out at 14.1 dp on the
 * standard Android cell (measured on the Profile gate target), and the card's
 * nearest spacing class is `h-4` (14 dp).
 */
const CAPTION_LINE_DP = 14.1;
/**
 * The funded note's line count at font scale 1: the sentence wraps to two
 * `caption` lines in this card's column (gate-measured at 28.19 dp), one line
 * for the empty message and one for the loading bar.
 */
const FUNDED_NOTE_LINES = 2;

/**
 * The sentence each failure kind paints: the connection's own wording, the
 * retryable line a deadline shares (the card has no separate sentence for a
 * wait that ended, and the server was reachable), the refusal, the terminal
 * read, or the transient failure beside its Retry.
 */
const BALANCE_FAILURE_COPY = {
  offline: 'profile.balanceUnreachable',
  timeout: 'profile.balanceLoadFailed',
  permission: 'profile.balanceAccessDenied',
  'not-found': 'profile.balanceUnavailable',
  terminal: 'profile.balanceUnavailable',
  retryable: 'profile.balanceLoadFailed',
} as const;

/**
 * The Profile credits card. The amount follows the selected context:
 * `getContextBalance` answers for Personal and for an organization where the
 * viewer is not a money role (a member's own spend balance, which the server
 * caps at the organization's balance), while `owner`, `admin` and
 * `billing_manager` paint the organization's own balance from
 * `organizations.list` — the same figure the Organization hub shows. A member's
 * amount carries a caption naming that scope.
 */
export function CreditsCard({ enabled, orgList }: Readonly<CreditsCardProps>) {
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
  //
  // The container reports that width one frame after it mounts, and the two
  // arms are not the same height: stacked reserves a 48pt value column, the
  // one-row arm takes the visibility control's own height. A first frame that
  // guessed "stacked" therefore shrank by 5.7 dp when the width landed and
  // moved every row below it (the held-loading gate run measured it on
  // `(3_profile)`). The body's width is the card's width here, so the first
  // frame reads it from the window and `onLayout` still owns the settled
  // answer for any container narrower than the body.
  //
  // The window is not quite the body: the tab scroller puts the safe-area side
  // margins on its own frame (`TabScreenScrollView`), so a landscape cutout
  // narrows the settled card by its inset on each side. Subtracting only the
  // gutter would guess a wider card than `onLayout` reports and could pick the
  // one-row arm where the settled width stacks — the first-frame arm switch
  // this line exists to prevent.
  const window = useWindowDimensions();
  const sideInsets = useStyleSideInsets();
  const bodyWidth = window.width - SCREEN_GUTTER_DP * 2 - sideInsets.left - sideInsets.right;
  const measuredWidth = availableWidth ?? bodyWidth;
  const stackBalance = measuredWidth / fontScale < 370;
  const { t, i18n } = useTranslation();
  // The picker no longer lives here: only a settled read can name an account
  // and carry a role, so this local feeds the balance lookup alone.
  const orgs = orgList.status === 'ready' ? orgList.orgs : undefined;
  const { organizationId, error, isSaving, retry } = useOrganization();
  const selectedOrgId = organizationId ?? undefined;

  const { hideBalance, hasLoaded: hideBalanceLoaded, setHideBalance } = useHideBalancePreference();
  const canLinkExternalPurchase = useCanLinkExternalPurchase();
  const {
    userId,
    isError: userIdError,
    error: userIdFailure,
    refetch: refetchUserId,
  } = useCurrentUserId({ enabled });
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
    error: balanceError,
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
  const balanceReadFailed = balanceQueryError || userIdError;

  // The credit reads are gated on `hasUserId`, so with a failed identity read
  // they can never answer. A money role's amount still paints — it comes from
  // the membership row — so the note slot carries that branch's exit instead.
  const identityReadBlocked = userIdError && !hasUserId;

  // A failed membership list is this surface's own failure for an organization
  // context, and only a fresh list can tell the card which balance that context
  // is owed, so the retry re-reads it too. The note slot's identity exit reads
  // the same control, so it is defined before that slot is built.
  const retryBalance = () => {
    if (orgList.status === 'error') {
      orgList.retry();
    }
    refetchUserId();
    void refetchBalance();
  };

  // Where the painted amount comes from. A money role (owner/admin/
  // billing_manager) manages the organization's money, so the card shows the
  // organization's own balance from `organizations.list` — the figure the
  // Organization hub paints. `getContextBalance` is the viewer's member spend
  // balance instead: for a plain member with a daily limit it is the remaining
  // allowance, which the server caps at the organization's balance, and for a
  // billing manager it answers `$0.00`, which is the defect this split fixes.
  const selectedEntry = orgs?.find(entry => entry.organizationId === selectedOrgId);
  const paintsOrgListBalance = selectedEntry !== undefined && isMoneyRole(selectedEntry.role);

  // The list is this context's own read: while it has not answered there is no
  // role to choose a source by, so the slot stays on its skeleton rather than
  // painting the member balance a money role cannot spend. A failed list read
  // owns the failure surface, because without it the card cannot know which
  // balance the context is entitled to.
  const orgListLoading = selectedOrgId != null && orgList.status === 'loading';
  const orgListError = selectedOrgId != null && orgList.status === 'error';

  const balanceFailed =
    orgListError || (!orgListLoading && !paintsOrgListBalance && balanceReadFailed);

  // The kind of the failure decides the copy and the action: a refusal is not a
  // transient failure, and a terminal one is the answer. Only a retryable or
  // offline failure offers Retry, because only those can succeed on a second
  // attempt. The read itself settles regardless of the online manager
  // (`SETTLE_WHILE_OFFLINE`), so an unreachable one names the connection by
  // having no server answer at all — no separate probe is needed here.
  const balanceFailureErrors = [balanceError, userIdFailure].filter(failure => failure != null);
  const balanceFailureKind = classifyReadFailureKind({
    errors: balanceFailureErrors,
    isPaused: false,
    connectivity: 'unknown',
  });
  const balanceRetryable = readFailureKindIsRetryable(balanceFailureKind);

  const creditData = selectedOrgId ? orgCreditData : personalCreditData;
  const creditsFailed = selectedOrgId ? orgCreditsError : personalCreditsError;
  const creditsPending =
    creditData === undefined || (Boolean(selectedOrgId) && orgCreditsPlaceholder);

  // Microdollars for a money role's organization, dollars from the member read
  // everywhere else.
  const balanceDollars = paintsOrgListBalance
    ? fromMicrodollars(selectedEntry.balance)
    : (balance?.balance ?? 0);
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
  const balancePending = balance === undefined && !balanceReadFailed;
  // `keepPreviousData` keeps the last account's amount on screen while the next
  // account's read runs, which would paint the previous account's balance under
  // the newly selected account's name with no cue at all. The skeleton owns that
  // window too, so a context switch never shows an amount that belongs to
  // another account; the read either answers or lands on `balanceFailed`.
  //
  // A money role's amount needs no read of its own: the list that answered the
  // role carries the balance with it, so that branch waits only for the mask
  // preference to load.
  const showBalanceSkeleton =
    !balanceFailed &&
    (orgListLoading ||
      (!paintsOrgListBalance && (balanceLoading || balancePending || balancePlaceholder)) ||
      !hideBalanceLoaded);

  // The member amount's scope: `getContextBalance` is the viewer's own spend
  // balance — a plain member's daily allowance, capped by the organization's
  // balance — not the organization's balance, so the row says which figure it
  // paints. It waits for the settled membership entry, because until the role
  // is known the caption would claim a scope the amount may not paint. Once the
  // role settles, the member branch keeps a row in this slot in its skeleton and
  // failure states too, so the slot never changes height as the amount lands.
  const organizationScopeNote =
    selectedEntry !== undefined && !isMoneyRole(selectedEntry.role) ? (
      <Text className="text-xs text-muted-foreground">
        {t('profile.availableToSpendInOrganization')}
      </Text>
    ) : null;

  // The note slot: the member's scope caption, then the expiry note, under the
  // amount. No entrance fade — the caption holds a row of this block, so a fade
  // that paints it late leaves it empty. A failing identity read joins the
  // failure state: its credits can never load, and a money role's amount still
  // paints from the membership row, so its exit lives here instead of over the
  // amount.
  const creditsNoteFailed = creditsFailed || identityReadBlocked;
  // Only the painting branch needs this exit: everywhere else the identity
  // failure owns the whole block, whose own retry already re-reads it.
  const identityNoteExit = identityReadBlocked && paintsOrgListBalance;
  // The expiry slot is a fixed box in every state: a funded account's sentence
  // ("… in credits expires … Credits with the earliest expiry are used first.")
  // wraps to two `caption` lines at this card's width and scale 1, the empty
  // message is one line and the loading bar is one. A one-line slot grew the
  // card by about 14 dp when funded credits landed and moved every row below it
  // (Profile held-loading gate target, 2026-11-20).
  //
  // Both the line's height and the sentence's line count grow with the font
  // scale, and the count grows faster than the scale: the column keeps its
  // width in dp while every glyph widens, so a sentence that takes two lines at
  // scale 1 takes about four at Android's largest scale. Reserving only
  // `2 × scale` lines left the box one line short from about scale 1.5 and grew
  // the card when a funded note landed — the shift this slot exists to prevent.
  const noteLines = Math.ceil(FUNDED_NOTE_LINES * fontScale);
  const noteSlot = (
    <>
      {organizationScopeNote}
      <View
        testID="credits-expiry-slot"
        style={{ minHeight: CAPTION_LINE_DP * fontScale * noteLines }}
      >
        {creditsNoteFailed &&
          (identityNoteExit ? (
            <View>
              <AccessibleStatus message={t('credits.expiryUnavailable')} className="text-sm" />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
                accessibilityHint={t('credits.expiryUnavailable')}
                onPress={retryBalance}
                className={cn(STATE_ACTION_CLASS, 'flex-row items-center gap-2 active:opacity-70')}
              >
                <Text className="text-sm text-primary">{t('common.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <Text className="text-xs text-muted-foreground">{t('credits.expiryUnavailable')}</Text>
          ))}
        {!creditsNoteFailed && creditsPending && (
          // The bar stands in for one `caption` line (14.1pt tall), so it takes
          // that line's height: a shorter bar lifted the value column, and the
          // row's centering moved the amount itself when the note landed.
          <Skeleton className="h-4 w-40 max-w-full rounded bg-muted-soft" />
        )}
        {!creditsNoteFailed && !creditsPending && (
          <CreditExpiryNote
            creditBlocks={creditData.creditBlocks}
            hiddenAmount={hideBalance || !hideBalanceLoaded ? HIDDEN_BALANCE : undefined}
            emptyMessage={t('credits.noExpiringCredits')}
          />
        )}
      </View>
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

  // One purchase entry for the section, whichever scope is selected: the
  // personal one is the in-app purchase, and an organization's is its billing
  // page, which only a money role on a storefront that may link to it can
  // offer — the same gate as the amount's own source. It lives in the Credits
  // header, so it never wraps to a row of its own in a narrow card and never
  // reads as a muted label with nothing to press.
  const orgBillingUrl =
    selectedOrgId != null && paintsOrgListBalance ? organizationBillingUrl(selectedOrgId) : null;
  let purchase: Readonly<{ label: string; onPress: () => void }> | null = null;
  if (selectedOrgId == null) {
    purchase = {
      label: t('addCredits.cta'),
      onPress: () => {
        router.push('/(app)/credits' as Href);
      },
    };
  } else if (orgBillingUrl !== null && canLinkExternalPurchase) {
    purchase = {
      label: t('addCredits.cta'),
      onPress: () => {
        void openExternalUrl(orgBillingUrl, { label: t('addCredits.billingPage') });
      },
    };
  }

  // The failure's own sentence: the variant names the cause, so a refusal is
  // not described as a transient failure and an unreachable read is not
  // described as the server's. Only the retryable case keeps the short line
  // beside a Retry.
  const balanceFailureLabel = t(BALANCE_FAILURE_COPY[balanceFailureKind]);

  // The retry line's spoken label names the action ("Tap to retry"), which the
  // visible sentence cannot carry in one line; the other kinds are statements.
  const balanceFailureAccessibilityLabel =
    balanceFailureKind === 'retryable' || balanceFailureKind === 'timeout'
      ? t('profile.failedToLoadBalance')
      : balanceFailureLabel;

  // The balance slot's state: one shell paints all three, so the card never
  // moves as the read answers, fails or retries.
  let balanceState: BalanceBlockState = 'ready';
  if (showBalanceSkeleton) {
    balanceState = 'loading';
  } else if (balanceFailed) {
    balanceState = {
      kind: 'failed',
      failure: {
        label: balanceFailureLabel,
        accessibilityLabel: balanceFailureAccessibilityLabel,
        retry: balanceRetryable
          ? { handleRetry: retryBalance, actionLabel: t('common.retry') }
          : undefined,
      },
    };
  }

  return (
    <View
      className="gap-3"
      onLayout={event => {
        setAvailableWidth(event.nativeEvent.layout.width);
      }}
    >
      <SectionHeader
        label={t('profile.credits')}
        actionLabel={purchase?.label}
        onActionPress={purchase?.onPress}
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
        note={noteSlot}
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
