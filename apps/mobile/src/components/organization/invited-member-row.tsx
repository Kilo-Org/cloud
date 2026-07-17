import { useActionSheet } from '@expo/react-native-action-sheet';
import { Alert, Pressable, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';
import { cn, formatDate, parseTimestamp } from '@/lib/utils';

import { ROLE_LABEL } from './member-row';

type InvitedMemberRowProps = {
  invite: InvitedOrgMember;
  /** Caller is owner. */
  canManage: boolean;
  organizationId: string;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
};

function inviteDateLabel(inviteDate: string | null): string | null {
  if (inviteDate == null) {
    return null;
  }
  return `Invited ${formatDate(parseTimestamp(inviteDate))}`;
}

export function InvitedMemberRow({
  invite,
  canManage,
  organizationId,
  last,
}: Readonly<InvitedMemberRowProps>) {
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const mutations = useOrganizationMutations(organizationId);
  const dateLabel = inviteDateLabel(invite.inviteDate);

  function confirmRevoke() {
    Alert.alert('Revoke invitation', `Revoke the invitation sent to ${invite.email}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          mutations.deleteInvite.mutate({ inviteId: invite.inviteId });
        },
      },
    ]);
  }

  function openActions() {
    const options = ['Share invite link', 'Revoke invitation', 'Cancel'];
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          void Share.share({ message: invite.inviteUrl });
        } else if (index === 1) {
          confirmRevoke();
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
          {invite.email}
        </Text>
        {dateLabel && (
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {dateLabel}
          </Text>
        )}
      </View>
      <View className="rounded-full bg-muted px-2 py-0.5">
        <Text className="text-[11px] font-medium text-muted-foreground">
          {ROLE_LABEL[invite.role]}
        </Text>
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
      accessibilityLabel={`Manage invitation for ${invite.email}`}
      className="px-3 active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
