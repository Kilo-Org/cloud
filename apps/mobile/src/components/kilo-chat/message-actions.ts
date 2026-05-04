const FIRST_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const;

type ReactionEmoji = (typeof FIRST_REACTION_EMOJIS)[number];

type MessageAction =
  | { kind: 'reaction'; label: string; emoji: ReactionEmoji }
  | { kind: 'more-reactions'; label: 'More reactions' }
  | { kind: 'reply'; label: 'Reply' }
  | { kind: 'copy'; label: 'Copy' }
  | { kind: 'edit'; label: 'Edit' }
  | { kind: 'delete'; label: 'Delete' }
  | { kind: 'cancel'; label: 'Cancel' };

type BuildMessageActionSheetOptionsInput = {
  canReact: boolean;
  canReply: boolean;
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isPendingMessage?: boolean;
};

export function buildMessageActionSheetOptions({
  canReact,
  canReply,
  canCopy,
  canEdit,
  canDelete,
  isPendingMessage = false,
}: BuildMessageActionSheetOptionsInput): {
  actions: MessageAction[];
  options: string[];
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
} {
  const actions: MessageAction[] = [];
  const canUseApiBackedActions = !isPendingMessage;
  if (canUseApiBackedActions && canReact) {
    for (const emoji of FIRST_REACTION_EMOJIS) {
      actions.push({ kind: 'reaction', label: emoji, emoji });
    }
    actions.push({ kind: 'more-reactions', label: 'More reactions' });
  }
  if (canUseApiBackedActions && canReply) {
    actions.push({ kind: 'reply', label: 'Reply' });
  }
  if (canCopy) {
    actions.push({ kind: 'copy', label: 'Copy' });
  }
  if (canUseApiBackedActions && canEdit) {
    actions.push({ kind: 'edit', label: 'Edit' });
  }
  if (canUseApiBackedActions && canDelete) {
    actions.push({ kind: 'delete', label: 'Delete' });
  }
  actions.push({ kind: 'cancel', label: 'Cancel' });

  const options = actions.map(action => action.label);
  const deleteButtonIndex = options.indexOf('Delete');
  const destructiveButtonIndex = deleteButtonIndex === -1 ? undefined : deleteButtonIndex;
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
