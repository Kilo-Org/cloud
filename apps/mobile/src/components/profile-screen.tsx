import { useMutation, useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import { GitPullRequest, KeyRound, LifeBuoy, Lock, LogOut, Trash2 } from 'lucide-react-native';
import { Alert, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RestorePurchasesButton } from '@/components/kilo-pass/restore-purchases-button';
import { NotificationsCard } from '@/components/notifications-card';
import { CreditsCard } from '@/components/profile-credits-card';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';
import { useTRPC } from '@/lib/trpc';

const SUPPORT_EMAIL = 'hi@kilo.ai';

function providerIcon(_provider: string) {
  return KeyRound;
}

function ActionTile({
  icon: Icon,
  label,
  color,
  onPress,
  destructive,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  color: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      className={`flex-1 items-center gap-2 rounded-lg bg-secondary py-4 active:opacity-70 ${disabled ? 'opacity-50' : ''}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      <Icon size={20} color={color} />
      <Text className={`text-sm ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ProfileScreen() {
  const { signOut, token } = useAuth();
  const router = useRouter();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const isAuthenticated = token != null;
  const {
    data,
    isLoading,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery({
    ...trpc.user.getAuthProviders.queryOptions(),
    enabled: isAuthenticated,
  });
  const { data: orgs } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: isAuthenticated,
  });

  const { userId } = useCurrentUserId({ enabled: isAuthenticated });
  const { organizationId } = useOrganization();

  const { bottom } = useSafeAreaInsets();

  const openSupportEmail = async () => {
    const envDetails = [
      `User ID: ${userId ?? 'unknown'}`,
      `App version: ${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`,
      `OS: ${Platform.OS} ${Platform.Version}`,
    ].join('\n');
    const body = `\n\n---\n${envDetails}`;
    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('mobile app feedback')}&body=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(url);
    } catch {
      toast.error(`No email app available. You can reach us at ${SUPPORT_EMAIL}`);
    }
  };

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

  const showPrivacyChoices = () => {
    router.push('/(app)/consent?mode=review' as Href);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Profile" size="large" showBackButton={false} />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4"
        contentContainerStyle={{ paddingBottom: getTabBarOverlayHeight(bottom, Platform.OS) + 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Credits */}
        <CreditsCard orgs={orgs} enabled={isAuthenticated} />

        {/* Code Reviewer */}
        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Agents
          </Text>
          <ConfigureRow
            icon={GitPullRequest}
            title="Code Reviewer"
            subtitle="Automatic PR reviews"
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/code-reviewer' as Href);
            }}
          />
        </View>

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

        {/* Restore Purchases (iOS-only; self-hides on Android and for org accounts) */}
        {Platform.OS === 'ios' && isAuthenticated && !organizationId ? (
          <View className="mt-6">
            <RestorePurchasesButton />
          </View>
        ) : null}

        {/* Actions */}
        <View className="mt-6 gap-3">
          <View className="flex-row gap-3">
            <ActionTile
              icon={LifeBuoy}
              label="Support"
              color={colors.mutedForeground}
              onPress={() => {
                void openSupportEmail();
              }}
            />
            <ActionTile
              icon={Lock}
              label="Privacy choices"
              color={colors.mutedForeground}
              onPress={showPrivacyChoices}
            />
          </View>
          <View className="flex-row gap-3">
            <ActionTile
              icon={LogOut}
              label="Sign Out"
              color={colors.mutedForeground}
              onPress={confirmSignOut}
            />
            <ActionTile
              icon={Trash2}
              label="Delete Account"
              color={colors.destructive}
              destructive
              disabled={deleteAccount.isPending}
              onPress={confirmDeleteAccount}
            />
          </View>

          <Text className="text-center text-xs text-muted-foreground">
            v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
