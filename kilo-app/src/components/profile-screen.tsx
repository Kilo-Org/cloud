import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Building2, KeyRound, LogOut, User } from 'lucide-react-native';
import { Alert, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useAppContext } from '@/lib/context/context-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

function providerIcon(_provider: string) {
  return KeyRound;
}

function CreditsCard() {
  const trpc = useTRPC();
  const { context } = useAppContext();
  const organizationId = context?.type === 'organization' ? context.organizationId : undefined;

  const {
    data: balance,
    isLoading: balanceLoading,
    isError: balanceError,
    refetch: refetchBalance,
  } = useQuery(trpc.user.getContextBalance.queryOptions({ organizationId }));

  const { data: creditData, isLoading: creditsLoading } = useQuery({
    ...trpc.user.getCreditBlocks.queryOptions({}),
    enabled: !organizationId,
  });

  const balanceDollars = balance?.balance ?? 0;
  const expiringBlocks = creditData?.creditBlocks.filter(b => b.expiry_date !== null) ?? [];
  const expiringTotal = expiringBlocks.reduce((sum, b) => sum + b.balance_mUsd, 0) / 1_000_000;
  const earliestExpiry = expiringBlocks
    .map(b => b.expiry_date)
    .filter((d): d is string => d !== null)
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
    .sort((a, b) => a.localeCompare(b))[0];

  return (
    <View className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        Remaining Credits
      </Text>
      {balanceLoading && <Skeleton className="h-12 w-32 rounded-lg" />}
      {balanceError && (
        <Pressable
          className="rounded-lg bg-secondary p-3 active:opacity-70"
          onPress={() => void refetchBalance()}
        >
          <Text className="text-sm text-destructive">Failed to load balance. Tap to retry.</Text>
        </Pressable>
      )}
      {!balanceLoading && !balanceError && (
        <View className="rounded-lg bg-secondary p-3">
          <Text className="text-2xl font-bold">${balanceDollars.toFixed(2)}</Text>
          {creditsLoading ? (
            <Skeleton className="mt-1 h-3 w-48 rounded" />
          ) : (
            expiringTotal > 0 &&
            Boolean(earliestExpiry) && (
              <Text className="mt-1 text-xs text-muted-foreground">
                ${expiringTotal.toFixed(2)} in bonus credits expiring{' '}
                {parseTimestamp(earliestExpiry).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
            )
          )}
        </View>
      )}
    </View>
  );
}

export function ProfileScreen() {
  const { signOut } = useAuth();
  const { context, clearContext } = useAppContext();
  const trpc = useTRPC();
  const {
    data,
    isLoading,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery(trpc.user.getAuthProviders.queryOptions());
  const { data: orgs } = useQuery(trpc.organizations.list.queryOptions());
  const colors = useThemeColors();

  const { bottom } = useSafeAreaInsets();

  const contextLabel =
    context?.type === 'personal'
      ? 'Personal'
      : (orgs?.find(o => o.organizationId === context?.organizationId)?.organizationName ??
        'Organization');

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'You will need to sign in again to access your workspace.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          void signOut();
        },
      },
    ]);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Profile" />
      <View className="flex-1 px-6 pt-4">
        {/* Active context */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Active Context
          </Text>
          <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
            {context?.type === 'personal' ? (
              <User size={18} color={colors.secondaryForeground} />
            ) : (
              <Building2 size={18} color={colors.secondaryForeground} />
            )}
            <Text className="text-sm font-medium">{contextLabel}</Text>
          </View>
        </View>

        {/* Credits */}
        <View className="mt-6">
          <CreditsCard />
        </View>

        {/* Linked accounts */}
        <Animated.View className="mt-6 gap-3" layout={LinearTransition}>
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Linked Accounts
          </Text>

          {isLoading && (
            <Animated.View className="gap-3" exiting={FadeOut.duration(150)}>
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </Animated.View>
          )}

          {providersError && (
            <Pressable
              className="rounded-lg bg-secondary p-3 active:opacity-70"
              onPress={() => {
                void refetchProviders();
              }}
            >
              <Text className="text-sm text-destructive">
                Failed to load accounts. Tap to retry.
              </Text>
            </Pressable>
          )}

          {data?.providers.map(p => {
            const Icon = providerIcon(p.provider);
            return (
              <Animated.View
                key={`${p.provider}-${p.email}`}
                className="flex-row items-center gap-3 rounded-lg bg-secondary p-3"
                entering={FadeIn.duration(200)}
              >
                <Icon size={18} color={colors.secondaryForeground} />
                <View className="flex-1">
                  <Text className="text-sm font-medium capitalize">{p.provider}</Text>
                  <Text variant="muted" className="text-xs">
                    {p.email}
                  </Text>
                </View>
              </Animated.View>
            );
          })}
        </Animated.View>

        {/* Actions */}
        <View className="mt-auto gap-3" style={{ paddingBottom: Math.max(bottom, 16) }}>
          <Button
            variant="outline"
            className="flex-row gap-2"
            onPress={() => {
              void clearContext();
            }}
            accessibilityLabel="Switch workspace"
          >
            <ArrowLeftRight size={16} color={colors.foreground} />
            <Text>Switch Context</Text>
          </Button>

          <Button
            variant="ghost"
            className="flex-row gap-2"
            onPress={confirmSignOut}
            accessibilityLabel="Sign out"
          >
            <LogOut size={16} color={colors.mutedForeground} />
            <Text className="text-muted-foreground">Sign Out</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}
