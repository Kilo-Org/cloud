import { useActionSheet } from '@expo/react-native-action-sheet';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react-native';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

type CreditsCardProps = {
  readonly enabled: boolean;
  orgs: { organizationId: string; organizationName: string }[] | undefined;
};

export function CreditsCard({ enabled, orgs }: Readonly<CreditsCardProps>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const { organizationId, setOrganizationId } = useOrganization();
  const selectedOrgId = organizationId ?? undefined;

  const {
    data: balance,
    isLoading: balanceLoading,
    isFetching: balanceFetching,
    isError: balanceError,
    refetch: refetchBalance,
  } = useQuery({
    ...trpc.user.getContextBalance.queryOptions({ organizationId: selectedOrgId }),
    enabled,
    placeholderData: keepPreviousData,
  });

  const { data: personalCreditData, isLoading: personalCreditsLoading } = useQuery({
    ...trpc.user.getCreditBlocks.queryOptions({}),
    enabled: enabled && !selectedOrgId,
  });

  const { data: orgCreditData, isLoading: orgCreditsLoading } = useQuery({
    ...trpc.organizations.getCreditBlocks.queryOptions({ organizationId: selectedOrgId ?? '' }),
    enabled: enabled && Boolean(selectedOrgId),
    placeholderData: keepPreviousData,
  });

  const creditData = selectedOrgId ? orgCreditData : personalCreditData;
  const creditsLoading = selectedOrgId ? orgCreditsLoading : personalCreditsLoading;

  const balanceDollars = balance?.balance ?? 0;
  const expiringBlocks = creditData?.creditBlocks.filter(b => b.expiry_date !== null) ?? [];
  const expiringTotal = expiringBlocks.reduce((sum, b) => sum + b.balance_mUsd, 0) / 1_000_000;
  const earliestExpiry = expiringBlocks
    .map(b => b.expiry_date)
    .filter((d): d is string => d !== null)
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
    .sort((a, b) => a.localeCompare(b))[0];

  const selectedLabel = selectedOrgId
    ? (orgs?.find(o => o.organizationId === selectedOrgId)?.organizationName ?? 'Organization')
    : 'Personal';

  const hasOrgs = orgs && orgs.length > 0;

  const openPicker = () => {
    if (!orgs || orgs.length === 0) {
      return;
    }
    const options = ['Personal', ...orgs.map(o => o.organizationName), 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        title: 'Select account',
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === undefined || index === cancelButtonIndex) {
          return;
        }
        if (index === 0) {
          setOrganizationId(null);
        } else {
          const org = orgs[index - 1];
          if (org) {
            setOrganizationId(org.organizationId);
          }
        }
      }
    );
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          Credits
        </Text>
        {hasOrgs && (
          <Pressable
            className="flex-row items-center gap-1 active:opacity-70"
            onPress={openPicker}
            hitSlop={8}
          >
            <Text className="text-xs font-medium text-muted-foreground">{selectedLabel}</Text>
            <ChevronDown size={14} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      {balanceLoading && <Skeleton className="h-16 w-full rounded-lg" />}
      {balanceError && (
        <Pressable
          className="h-16 justify-center rounded-lg bg-secondary px-3 active:opacity-70"
          onPress={() => void refetchBalance()}
        >
          <Text className="text-sm text-destructive">Failed to load balance. Tap to retry.</Text>
        </Pressable>
      )}
      {!balanceLoading && !balanceError && (
        <View className="h-16 flex-row items-center rounded-lg bg-secondary px-3">
          <Animated.View className="flex-1 justify-center" layout={LinearTransition.duration(200)}>
            <Text className="text-2xl font-bold">${balanceDollars.toFixed(2)}</Text>
            {creditsLoading ? (
              <Animated.View exiting={FadeOut.duration(150)}>
                <Skeleton className="mt-1 h-3 w-48 rounded" />
              </Animated.View>
            ) : (
              expiringTotal > 0 &&
              earliestExpiry != null && (
                <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
                  <Text className="text-xs text-muted-foreground">
                    ${expiringTotal.toFixed(2)} in bonus credits expiring{' '}
                    {parseTimestamp(earliestExpiry).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </Text>
                </Animated.View>
              )
            )}
          </Animated.View>
          {balanceFetching && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        </View>
      )}
      {enabled && !selectedOrgId && <KiloPassSubscriptionCard />}
    </View>
  );
}
