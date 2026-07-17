import { useActionSheet } from '@expo/react-native-action-sheet';
import { formatDollars } from '@kilocode/app-shared/utils';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Alert, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type ActiveOrgMember, type OrgRole } from '@/lib/hooks/use-organization-queries';
import { cn, firstNonEmpty } from '@/lib/utils';

type MemberRowProps = {
  member: ActiveOrgMember;
  /** Caller is owner and this isn't their own row. */
  canManage: boolean;
  enableUsageLimits: boolean;
  organizationId: string;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
};

export const ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  member: 'Member',
  billing_manager: 'Billing manager',
};

const ROLE_OPTIONS: OrgRole[] = ['owner', 'member', 'billing_manager'];

export function MemberRow({
  member,
  canManage,
  enableUsageLimits,
  organizationId,
  last,
}: Readonly<MemberRowProps>) {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const mutations = useOrganizationMutations(organizationId);
  const displayName = firstNonEmpty(member.name, member.email);

  function openRoleSheet() {
    const options = [...ROLE_OPTIONS.map(role => ROLE_LABEL[role]), 'Cancel'];
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        const role = index !== undefined ? ROLE_OPTIONS[index] : undefined;
        if (!role) {
          return;
        }
        mutations.updateMember.mutate(
          { memberId: member.id, role },
          {
            onSuccess: () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            },
          }
        );
      }
    );
  }

  function confirmRemove() {
    Alert.alert('Remove member', `Remove ${displayName} from this organization?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          mutations.removeMember.mutate(
            { memberId: member.id },
            {
              onSuccess: () => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              },
            }
          );
        },
      },
    ]);
  }

  function openActions() {
    const options = [
      'Change role',
      ...(enableUsageLimits ? ['Set daily usage limit'] : []),
      'Remove member',
      'Cancel',
    ];
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: options.length - 2,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        const label = index !== undefined ? options[index] : undefined;
        if (label === 'Change role') {
          openRoleSheet();
        } else if (label === 'Set daily usage limit') {
          router.push(
            `/(app)/(tabs)/(3_profile)/organization/member-limit?memberId=${member.id}` as Href
          );
        } else if (label === 'Remove member') {
          confirmRemove();
        }
      }
    );
  }

  const inner = (
    <View
      className={cn(
        'flex-row items-center justify-between gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {displayName}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {member.email}
        </Text>
      </View>
      <View className="items-end gap-1">
        <View className="rounded-full bg-muted px-2 py-0.5">
          <Text className="text-[11px] font-medium text-muted-foreground">
            {ROLE_LABEL[member.role]}
          </Text>
        </View>
        {member.dailyUsageLimitUsd != null && (
          <Text className="text-xs text-muted-foreground">
            {formatDollars(member.dailyUsageLimitUsd)}/day
          </Text>
        )}
      </View>
    </View>
  );

  if (!canManage) {
    return <View className="px-3">{inner}</View>;
  }

  return (
    <Pressable
      onPress={openActions}
      accessibilityRole="button"
      accessibilityLabel={`Manage ${displayName}`}
      className="px-3 active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
