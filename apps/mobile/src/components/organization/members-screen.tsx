import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { UserPlus, Users } from '@/components/ui/icons';
import { useMemo } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { InvitedMemberRow } from '@/components/organization/invited-member-row';
import { MemberRow } from '@/components/organization/member-row';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  type ActiveOrgMember,
  type InvitedOrgMember,
  isActiveOrgMember,
  isInvitedOrgMember,
  isMoneyRole,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn, firstNonEmpty, parseTimestamp } from '@/lib/utils';

import { buildMembersListItems, type MembersListItem } from './members-list-items';
import { selectOrgListErrorView } from './org-list-error-view';

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

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingTop: 16, flexGrow: 1 } satisfies ViewStyle;

export function OrganizationMembersScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const { userId: currentUserId } = useCurrentUserId();
  const paddingBottom = useTabBarBottomPadding();

  const members = orgWithMembers.data?.members ?? [];
  const activeMembers = sortActiveMembers(members.filter(m => isActiveOrgMember(m)));
  const invitedMembers = sortInvitedMembers(members.filter(m => isInvitedOrgMember(m)));

  const items = useMemo(
    () => buildMembersListItems({ activeMembers, invitedMembers }),
    [activeMembers, invitedMembers]
  );

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title="Members" />;
  }

  const isLoading = orgWithMembers.isLoading;
  const isError = orgWithMembers.isError && !orgWithMembers.data;
  const enableUsageLimits = orgWithMembers.data?.settings.enable_usage_limits !== false;
  const canInvite = isMoneyRole(role);
  const isOwner = role === 'owner';

  const errorView = isError ? selectOrgListErrorView(orgWithMembers.error) : null;

  const emptyState = (
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

  // Loading, error, and empty are mutually exclusive and evaluated in this
  // order. An error leaves both member arrays empty, so it must be checked
  // before the empty branch — otherwise a 500 renders "No members yet".
  const renderListEmpty = () => {
    if (isLoading) {
      return (
        <View className="mx-6 rounded-lg bg-secondary">
          <MemberRowSkeleton />
          <MemberRowSkeleton />
          <MemberRowSkeleton last />
        </View>
      );
    }
    if (errorView) {
      return (
        <QueryError
          variant={errorView.variant}
          onRetry={errorView.showRetry ? () => void orgWithMembers.refetch() : undefined}
          isRetrying={orgWithMembers.isFetching}
          placement="top"
        />
      );
    }
    return emptyState;
  };

  const renderItem = ({ item, index }: { item: MembersListItem; index: number }) => {
    switch (item.kind) {
      case 'section': {
        return (
          <View className="bg-background px-6 pb-2 pt-4">
            <Text variant="eyebrow">{item.title}</Text>
          </View>
        );
      }
      case 'members-empty': {
        return emptyState;
      }
      case 'member': {
        const isFirst = index === 0 || items[index - 1]?.kind === 'section';
        return (
          <View
            className={cn(
              'mx-6 bg-secondary',
              isFirst && 'rounded-t-lg',
              item.last && 'rounded-b-lg'
            )}
          >
            <MemberRow
              member={item.member}
              canManage={isOwner && item.member.id !== currentUserId}
              enableUsageLimits={enableUsageLimits}
              organizationId={organizationId}
              last={item.last}
            />
          </View>
        );
      }
      case 'invite': {
        const isFirst = index === 0 || items[index - 1]?.kind === 'section';
        return (
          <View
            className={cn(
              'mx-6 bg-secondary',
              isFirst && 'rounded-t-lg',
              item.last && 'rounded-b-lg'
            )}
          >
            <InvitedMemberRow
              invite={item.invite}
              canManage={isOwner}
              organizationId={organizationId}
              last={item.last}
            />
          </View>
        );
      }
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  };

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
      <FlashList
        style={listStyle}
        data={items}
        renderItem={renderItem}
        keyExtractor={item => {
          switch (item.kind) {
            case 'section': {
              return `section:${item.title}`;
            }
            case 'members-empty': {
              return 'members-empty';
            }
            case 'member': {
              return item.member.id;
            }
            case 'invite': {
              return item.invite.inviteId;
            }
            default: {
              const _exhaustive: never = item;
              return _exhaustive;
            }
          }
        }}
        getItemType={item => item.kind}
        ListEmptyComponent={renderListEmpty}
        ListFooterComponent={<View style={{ height: paddingBottom }} pointerEvents="none" />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={listContentContainerStyle}
      />
    </View>
  );
}
