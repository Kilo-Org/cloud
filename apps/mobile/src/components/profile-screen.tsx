import { useMutation, useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type Href, useRouter } from 'expo-router';
import {
  Building2,
  GitPullRequest,
  KeyRound,
  Lock,
  LogOut,
  MessageSquare,
  ShieldCheck,
  Trash2,
} from 'lucide-react-native';
import { Alert, Platform, View } from 'react-native';
import { toast } from 'sonner-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { RestorePurchasesButton } from '@/components/kilo-pass/restore-purchases-button';
import { NotificationsCard } from '@/components/notifications-card';
import { ActionTile } from '@/components/profile-action-tile';
import { CreditsCard } from '@/components/profile-credits-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { showFeedbackPrompt } from '@/lib/feedback';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { getCodeReviewerProfilePath, getProfileAgentScope } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

function providerIcon(_provider: string) {
  return KeyRound;
}

export function ProfileScreen() {
  const { signOut, token } = useAuth();
  const router = useRouter();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { organizationId, isLoaded: organizationContextLoaded } = useOrganization();
  const isAuthenticated = token != null;
  const {
    data,
    isLoading,
    isError: providersError,
    isFetching: providersFetching,
    refetch: refetchProviders,
  } = useQuery({
    ...trpc.user.getAuthProviders.queryOptions(),
    enabled: isAuthenticated,
  });
  const {
    data: orgs,
    isFetching: organizationsFetching,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: isAuthenticated,
  });
  const agentScope = organizationContextLoaded
    ? getProfileAgentScope(organizationId, orgs, organizationsFetching)
    : undefined;
  const selectedOrg = orgs?.find(org => org.organizationId === organizationId);
  const orgRole = selectedOrg?.role;
  const orgName = selectedOrg?.organizationName;

  const { userId } = useCurrentUserId({ enabled: isAuthenticated });

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
      'Delete account?',
      'This will send a request to permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
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
        text: 'Sign out',
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
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4"
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
            disabled={!agentScope}
            onPress={() => {
              if (agentScope) {
                router.push(getCodeReviewerProfilePath(agentScope));
              }
            }}
          />
          <ConfigureRow
            icon={ShieldCheck}
            title="Security Agent"
            subtitle="Find and remediate vulnerabilities"
            className="rounded-lg bg-secondary px-3"
            disabled={!agentScope}
            last
            onPress={() => {
              if (agentScope) {
                router.push(getSecurityAgentPath(agentScope));
              }
            }}
          />
        </View>

        {/* Organization */}
        {organizationId != null && (
          <View className="mt-6 gap-3">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Organization
            </Text>
            {organizationsError ? (
              <QueryError
                variant="server"
                placement="top"
                title="Could not load organization"
                message="Organization and agent settings are unavailable until this loads."
                onRetry={() => void refetchOrganizations()}
                isRetrying={organizationsFetching}
              />
            ) : (
              <ConfigureRow
                icon={Building2}
                title={orgRole === 'member' ? 'View organization' : 'Manage organization'}
                subtitle={orgName}
                className="rounded-lg bg-secondary px-3"
                disabled={!orgRole}
                last
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization' as Href);
                }}
              />
            )}
          </View>
        )}

        {/* Linked accounts — hide the whole section when there are no linked
            providers (and we're not loading/erroring) so the header never dangles. */}
        {(isLoading || providersError || (data?.providers.length ?? 0) > 0) && (
          <Animated.View className="mt-6 gap-3" layout={LinearTransition}>
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Linked accounts
            </Text>

            {isLoading && (
              <Animated.View exiting={FadeOut.duration(150)}>
                <Skeleton className="h-12 w-full rounded-lg" />
              </Animated.View>
            )}

            {providersError && (
              <QueryError
                variant="server"
                placement="top"
                title="Could not load accounts"
                onRetry={() => void refetchProviders()}
                isRetrying={providersFetching}
              />
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
        )}

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
              icon={MessageSquare}
              label="Feedback"
              color={colors.mutedForeground}
              onPress={() => {
                showFeedbackPrompt(userId);
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
      </TabScreenScrollView>
    </View>
  );
}
