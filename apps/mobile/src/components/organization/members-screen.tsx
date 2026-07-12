import { type Href, useRouter } from 'expo-router';
import { UserPlus, Users } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { InvitedMemberRow } from '@/components/organization/invited-member-row';
import { MemberRow } from '@/components/organization/member-row';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  type ActiveOrgMember,
  type InvitedOrgMember,
  isMoneyRole,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { firstNonEmpty, parseTimestamp } from '@/lib/utils';

function sortActiveMembers(members: ActiveOrgMember[]): ActiveOrgMember[] {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
  return [...members].sort((a, b) =>
    firstNonEmpty(a.name, a.email).localeCompare(firstNonEmpty(b.name, b.email))
  );
}

function sortInvitedMembers(invites: InvitedOrgMember[]): InvitedOrgMember[] {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
  return [...invites].sort((a, b) => {
    if (a.inviteDate == null) {
      return b.inviteDate == null ? 0 : 1;
    }
    if (b.inviteDate == null) {
      return -1;
    }
    return parseTimestamp(b.inviteDate).getTime() - parseTimestamp(a.inviteDate).getTime();
  });
}

function MemberRowSkeleton({ last }: Readonly<{ last?: boolean }>) {
  return (
    <View className={!last ? 'border-b-[0.5px] border-hair-soft' : undefined}>
      <View className="gap-1.5 px-3 py-3">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-3 w-44 rounded" />
      </View>
    </View>
  );
}

export function OrganizationMembersScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const { userId: currentUserId } = useCurrentUserId();

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title="Members" />;
  }

  const isLoading = orgWithMembers.isLoading;
  const isError = orgWithMembers.isError && !orgWithMembers.data;
  const enableUsageLimits = orgWithMembers.data?.settings.enable_usage_limits !== false;
  const canInvite = isMoneyRole(role);
  const isOwner = role === 'owner';

  const activeMembers = sortActiveMembers(
    orgWithMembers.data?.members.filter(m => m.status === 'active') ?? []
  );
  const invitedMembers = sortInvitedMembers(
    orgWithMembers.data?.members.filter(m => m.status === 'invited') ?? []
  );

  let membersBody: ReactNode = null;
  if (isLoading) {
    membersBody = (
      <Animated.View exiting={FadeOut.duration(150)} className="rounded-lg bg-secondary">
        <MemberRowSkeleton />
        <MemberRowSkeleton />
        <MemberRowSkeleton last />
      </Animated.View>
    );
  } else if (isError) {
    membersBody = (
      <QueryError
        onRetry={() => void orgWithMembers.refetch()}
        isRetrying={orgWithMembers.isFetching}
        placement="top"
      />
    );
  } else if (activeMembers.length === 0) {
    membersBody = (
      <EmptyState
        icon={Users}
        placement="top"
        title="No members yet"
        description={
          canInvite
            ? 'Invite teammates to start collaborating in this organization.'
            : 'Ask an owner or billing manager to invite teammates.'
        }
        action={
          canInvite ? (
            <Button
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/organization/invite-member' as Href);
              }}
            >
              <Text className="text-primary-foreground">Invite member</Text>
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    membersBody = (
      <Animated.View entering={FadeIn.duration(200)} className="rounded-lg bg-secondary">
        {activeMembers.map((member, index) => (
          <MemberRow
            key={member.id}
            member={member}
            canManage={isOwner && member.id !== currentUserId}
            enableUsageLimits={enableUsageLimits}
            organizationId={organizationId}
            last={index === activeMembers.length - 1}
          />
        ))}
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Members"
        headerRight={
          canInvite ? (
            <Pressable
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/organization/invite-member' as Href);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Invite member"
              className="active:opacity-70"
            >
              <UserPlus size={22} color={colors.foreground} />
            </Pressable>
          ) : undefined
        }
      />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View layout={LinearTransition} className="gap-2">
          <Text variant="eyebrow">Members</Text>
          {membersBody}
        </Animated.View>

        {!isLoading && !isError && invitedMembers.length > 0 && (
          <Animated.View
            entering={FadeIn.duration(200)}
            layout={LinearTransition}
            className="gap-2"
          >
            <Text variant="eyebrow">Pending invitations</Text>
            <View className="rounded-lg bg-secondary">
              {invitedMembers.map((invite, index) => (
                <InvitedMemberRow
                  key={invite.inviteId}
                  invite={invite}
                  canManage={isOwner}
                  organizationId={organizationId}
                  last={index === invitedMembers.length - 1}
                />
              ))}
            </View>
          </Animated.View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
