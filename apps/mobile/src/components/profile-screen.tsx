import { useActionSheet } from '@expo/react-native-action-sheet';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { ChevronDown, KeyRound, LogOut, Trash2 } from 'lucide-react-native';
import { ActivityIndicator, Alert, Platform, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { NotificationsCard } from '@/components/notifications-card';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

function providerIcon(_provider: string) {
  return KeyRound;
}

type CreditsCardProps = {
  orgs: { organizationId: string; organizationName: string }[] | undefined;
};

function CreditsCard({ orgs }: Readonly<CreditsCardProps>) {
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
    placeholderData: keepPreviousData,
  });

  const { data: personalCreditData, isLoading: personalCreditsLoading } = useQuery({
    ...trpc.user.getCreditBlocks.queryOptions({}),
    enabled: !selectedOrgId,
  });

  const { data: orgCreditData, isLoading: orgCreditsLoading } = useQuery({
    ...trpc.organizations.getCreditBlocks.queryOptions({ organizationId: selectedOrgId ?? '' }),
    enabled: Boolean(selectedOrgId),
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
    </View>
  );
}

export function ProfileScreen() {
  const { signOut } = useAuth();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const {
    data,
    isLoading,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery(trpc.user.getAuthProviders.queryOptions());
  const { data: orgs } = useQuery(trpc.organizations.list.queryOptions());

  const { bottom } = useSafeAreaInsets();

  const deleteAccount = useMutation(
    trpc.user.requestAccountDeletion.mutationOptions({
      onSuccess: () => {
        toast.success('Account deletion request sent. Check your email for confirmation.');
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete Account?',
      'This will send a request to permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => {
            deleteAccount.mutate();
          },
        },
      ]
    );
  };

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
      <ScreenHeader title="Profile" modal />
      <View className="flex-1 px-6 pt-4">
        {/* Credits */}
        <CreditsCard orgs={orgs} />

        {/* Linked accounts */}
        <Animated.View className="mt-6 gap-3" layout={LinearTransition}>
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Linked Accounts
          </Text>

          {isLoading && (
            <Animated.View exiting={FadeOut.duration(150)}>
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

        {/* Notifications */}
        <View className="mt-6">
          <NotificationsCard />
        </View>

        {/* Actions */}
        <View
          className="mt-auto gap-3"
          style={{ paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0) }}
        >
          <Button
            variant="ghost"
            className="flex-row gap-2"
            onPress={confirmSignOut}
            accessibilityLabel="Sign out"
          >
            <LogOut size={16} color={colors.mutedForeground} />
            <Text className="text-muted-foreground">Sign Out</Text>
          </Button>

          <Button
            variant="ghost"
            className="flex-row gap-2"
            onPress={confirmDeleteAccount}
            disabled={deleteAccount.isPending}
            accessibilityLabel="Delete account"
          >
            <Trash2 size={16} color={colors.destructive} />
            <Text className="text-destructive">Delete Account</Text>
          </Button>

          <Text className="text-center text-xs text-muted-foreground">
            v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
          </Text>
        </View>
      </View>
    </View>
  );
}
