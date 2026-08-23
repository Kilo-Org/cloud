import { i18n } from '@/i18n';

const FIRST_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const;

type ReactionEmoji = (typeof FIRST_REACTION_EMOJIS)[number];

type MessageAction =
  | { kind: 'retry'; label: string }
  | { kind: 'reaction'; label: string; emoji: ReactionEmoji }
  | { kind: 'more-reactions'; label: string }
  | { kind: 'reply'; label: string }
  | { kind: 'copy'; label: string }
  | { kind: 'edit'; label: string }
  | { kind: 'delete'; label: string }
  | { kind: 'cancel'; label: string };

type BuildMessageActionSheetOptionsInput = {
  canReact: boolean;
  canReply: boolean;
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRetry?: boolean;
  isPendingMessage?: boolean;
};

export function buildMessageActionSheetOptions({
  canReact,
  canReply,
  canCopy,
  canEdit,
  canDelete,
  canRetry = false,
  isPendingMessage = false,
}: BuildMessageActionSheetOptionsInput) {
  const actions: MessageAction[] = [];
  const canUseApiBackedActions = !isPendingMessage;
  if (canRetry) {
    actions.push({ kind: 'retry', label: i18n.t('chat.messageActions.retrySend') });
  }
  if (canUseApiBackedActions && canReact) {
    for (const emoji of FIRST_REACTION_EMOJIS) {
      actions.push({ kind: 'reaction', label: emoji, emoji });
    }
    actions.push({ kind: 'more-reactions', label: i18n.t('chat.messageActions.moreReactions') });
  }
  if (canUseApiBackedActions && canReply) {
    actions.push({ kind: 'reply', label: i18n.t('chat.messageActions.reply') });
  }
  if (canCopy) {
    actions.push({ kind: 'copy', label: i18n.t('common.copy') });
  }
  if (canUseApiBackedActions && canEdit) {
    actions.push({ kind: 'edit', label: i18n.t('chat.messageActions.edit') });
  }
  if (canUseApiBackedActions && canDelete) {
    actions.push({ kind: 'delete', label: i18n.t('chat.messageActions.delete') });
  }
  actions.push({ kind: 'cancel', label: i18n.t('common.cancel') });

  const options = actions.map(action => action.label);
  const deleteIndex = actions.findIndex(action => action.kind === 'delete');
  const destructiveButtonIndex = deleteIndex === -1 ? undefined : deleteIndex;
  return {
    actions,
    options,
    cancelButtonIndex: options.length - 1,
    ...(destructiveButtonIndex !== undefined && { destructiveButtonIndex }),
  };
}

export function getSelectedMessageAction(
  actionSheet: ReturnType<typeof buildMessageActionSheetOptions>,
  index: number | undefined
): Exclude<MessageAction, { kind: 'cancel' }> | null {
  if (index === undefined || index === actionSheet.cancelButtonIndex) {
    return null;
  }

  const action = actionSheet.actions[index];
  if (!action || action.kind === 'cancel') {
    return null;
  }

  return action;
}
