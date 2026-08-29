import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown } from '@/components/ui/icons';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { AddCreditsRow } from '@/components/add-credits-row';
import { useContextPicker } from '@/components/context-control';
import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isMoneyRole, type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

type CreditsCardProps = {
  readonly enabled: boolean;
  orgs: OrgListEntry[] | undefined;
};

export function CreditsCard({ enabled, orgs }: Readonly<CreditsCardProps>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const openPicker = useContextPicker(orgs);
  const { organizationId, error, retry } = useOrganization();
  const selectedOrgId = organizationId ?? undefined;

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
    isFetching: balanceFetching,
    isError: balanceQueryError,
    refetch: refetchBalance,
  } = useQuery({
    ...balanceOptions,
    enabled: enabled && hasUserId,
    placeholderData: keepPreviousData,
  });

  const { data: personalCreditData, isLoading: personalCreditsLoading } = useQuery({
    ...personalCreditOptions,
    enabled: enabled && hasUserId && !selectedOrgId,
  });

  const { data: orgCreditData, isLoading: orgCreditsLoading } = useQuery({
    ...orgCreditOptions,
    enabled: enabled && hasUserId && Boolean(selectedOrgId),
    placeholderData: keepPreviousData,
  });

  // A failed getMe (no userId) can never render a trusted balance, so it shares
  // the balance error surface. Retry re-resolves the owner and re-fetches.
  const balanceFailed = balanceQueryError || userIdError;

  const creditData = selectedOrgId ? orgCreditData : personalCreditData;
  const creditsLoading = selectedOrgId ? orgCreditsLoading : personalCreditsLoading;

  const balanceDollars = balance?.balance ?? 0;
  // A paused query (offline/unknown connectivity, empty cache) is pending but
  // not fetching, so `balanceLoading` (isLoading) is false while `balance`
  // is still undefined. Treat "no data yet" as loading so the card shows a
  // skeleton instead of `$0` on a cold launch before NetInfo settles.
  const balancePending = balance === undefined && !balanceFailed;
  const expiringBlocks = creditData?.creditBlocks.filter(b => b.expiry_date !== null) ?? [];
  const expiringTotal = fromMicrodollars(
    expiringBlocks.reduce((sum, b) => sum + b.balance_mUsd, 0)
  );
  const earliestExpiry = expiringBlocks
    .map(b => b.expiry_date)
    .filter((d): d is string => d !== null)
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
    .sort((a, b) => parseTimestamp(a).getTime() - parseTimestamp(b).getTime())[0];

  const selectedLabel = selectedOrgId
    ? (orgs?.find(o => o.organizationId === selectedOrgId)?.organizationName ??
      t('profile.organization'))
    : t('profile.personal');

  const canPickContext = orgs !== undefined;

  // Personal (non-org) credits are a consumable purchased directly by the end
  // user, so Apple requires IAP for them — iOS can't show purchase language
  // pointing at the web billing page. Org billing is exempt (business/seat
  // billing), but only members who can manage billing should see the CTA —
  // matching the money-role gate on the organization hub screen.
  const selectedOrgRole = orgs?.find(o => o.organizationId === selectedOrgId)?.role;
  const canShowZeroBalanceCta =
    selectedOrgId != null ? isMoneyRole(selectedOrgRole) : Platform.OS !== 'ios';
  const zeroBalanceUrl = selectedOrgId
    ? `${WEB_BASE_URL}/organizations/${selectedOrgId}/payment-details`
    : `${WEB_BASE_URL}/credits`;

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('profile.credits')}
        </Text>
        {canPickContext && (
          <Pressable
            className="flex-row items-center gap-1 active:opacity-70"
            onPress={openPicker}
            accessibilityRole="button"
            accessibilityLabel={selectedLabel}
            accessibilityHint={t('profile.selectAccount')}
            hitSlop={8}
          >
            <Text className="text-xs font-medium text-muted-foreground">{selectedLabel}</Text>
            <ChevronDown size={14} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>
      {error === 'save' && (
        <View>
          <AccessibleStatus message={t('common.couldNotSaveSetting')} className="text-sm" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            accessibilityHint={t('common.couldNotSaveSetting')}
            onPress={retry}
            className="min-h-11 justify-center active:opacity-70"
          >
            <Text className="text-sm text-primary">{t('common.retry')}</Text>
          </Pressable>
        </View>
      )}

      {(balanceLoading || balancePending) && <Skeleton className="min-h-16 w-full rounded-lg" />}
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
      {!balanceLoading && !balancePending && !balanceFailed && (
        <View className="min-h-16 flex-row items-center rounded-lg bg-secondary px-3 py-2">
          <Animated.View className="flex-1 justify-center" layout={LinearTransition.duration(200)}>
            <Text className="text-2xl font-bold">{formatMoney(balanceDollars, i18n.language)}</Text>
            {creditsLoading ? (
              <Animated.View exiting={FadeOut.duration(150)}>
                <Skeleton className="mt-1 h-3 w-48 rounded" />
              </Animated.View>
            ) : (
              expiringTotal > 0 &&
              earliestExpiry != null && (
                <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
                  <Text className="text-xs text-muted-foreground">
                    {t('profile.bonusCreditsExpiring', {
                      amount: formatMoney(expiringTotal, i18n.language),
                      date: formatDate(parseTimestamp(earliestExpiry), i18n.language),
                    })}
                  </Text>
                </Animated.View>
              )
            )}
          </Animated.View>
          {balanceFetching && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        </View>
      )}
      {!balanceLoading &&
        !balancePending &&
        !balanceFailed &&
        balanceDollars === 0 &&
        canShowZeroBalanceCta && (
          <AddCreditsRow url={zeroBalanceUrl} className="rounded-lg bg-secondary px-3 py-3" />
        )}
      {/* Personal-context IAP disclosure only — never show this personal "managed
          outside the iOS app" copy under an org context (org billing isn't personal
          IAP, and a non-money-role member just lacks access). */}
      {!balanceLoading &&
        !balancePending &&
        !balanceFailed &&
        balanceDollars === 0 &&
        !canShowZeroBalanceCta &&
        selectedOrgId == null && (
          <View className="flex-row items-center justify-between rounded-lg bg-secondary px-3 py-3">
            <Text className="flex-1 pr-3 text-xs text-muted-foreground">
              {t('profile.creditBalanceEmpty')}
            </Text>
          </View>
        )}
      {enabled && !selectedOrgId ? <KiloPassSubscriptionCard /> : null}
    </View>
  );
}
