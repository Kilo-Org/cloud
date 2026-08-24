import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';
import { cn, parseTimestamp } from '@/lib/utils';

import {
  emailStatusLabel,
  invitedMemberActionOptions,
  useResendInvite,
} from './invited-member-row-state';
import { roleLabel } from './member-row';

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
  return i18n.t('organization.members.invitedDate', {
    date: formatDate(parseTimestamp(inviteDate), i18n.language),
  });
}

export function InvitedMemberRow({
  invite,
  canManage,
  organizationId,
  last,
}: Readonly<InvitedMemberRowProps>) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const { showActionSheetWithOptions } = useActionSheet();
  const mutations = useOrganizationMutations(organizationId);
  const resendInvite = useResendInvite(organizationId);
  const dateLabel = inviteDateLabel(invite.inviteDate);
  const statusLabel = emailStatusLabel(invite.emailStatus);

  function confirmRevoke() {
    Alert.alert(
      t('organization.members.revokeInvitation'),
      t('organization.members.revokeInvitationMessage', { email: invite.email }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('organization.members.revokeConfirm'),
          style: 'destructive',
          onPress: () => {
            mutations.deleteInvite.mutate({ inviteId: invite.inviteId });
          },
        },
      ]
    );
  }

  function openActions() {
    const hasInviteUrl = 'inviteUrl' in invite;
    const shareLabel = t('organization.members.shareInviteLink');
    const resendLabel = t('organization.members.resendInvite');
    const revokeLabel = t('organization.members.revokeInvitation');
    const options = invitedMemberActionOptions(invite.emailStatus, hasInviteUrl);
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: options.length - 2,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        const label = index !== undefined ? options[index] : undefined;
        if (label === shareLabel) {
          if ('inviteUrl' in invite) {
            void Share.share({ message: invite.inviteUrl });
          }
        } else if (label === resendLabel) {
          resendInvite.mutate({ inviteId: invite.inviteId });
        } else if (label === revokeLabel) {
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
        {statusLabel && (
          <Text
            className={cn(
              'mt-0.5 text-xs',
              invite.emailStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            )}
            numberOfLines={1}
          >
            {statusLabel}
          </Text>
        )}
      </View>
      <View className="rounded-full bg-muted px-2 py-0.5">
        <Text className="text-[11px] font-medium text-muted-foreground">
          {roleLabel(invite.role)}
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
      accessibilityLabel={t('organization.members.manageInvitationA11y', { email: invite.email })}
      className="px-3 active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
