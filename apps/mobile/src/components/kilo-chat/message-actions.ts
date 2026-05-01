export const FIRST_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const;

type ReactionEmoji = (typeof FIRST_REACTION_EMOJIS)[number];

export type MessageAction =
  | { kind: 'reaction'; label: string; emoji: ReactionEmoji }
  | { kind: 'reply'; label: 'Reply' }
  | { kind: 'edit'; label: 'Edit' }
  | { kind: 'delete'; label: 'Delete' }
  | { kind: 'cancel'; label: 'Cancel' };

type BuildMessageActionSheetOptionsInput = {
  isOwnMessage: boolean;
  canReact: boolean;
  canReply: boolean;
};

export function buildMessageActionSheetOptions({
  isOwnMessage,
  canReact,
  canReply,
}: BuildMessageActionSheetOptionsInput): {
  actions: MessageAction[];
  options: string[];
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
} {
  const actions: MessageAction[] = [];
  if (canReact) {
    for (const emoji of FIRST_REACTION_EMOJIS) {
      actions.push({ kind: 'reaction', label: `${emoji} React`, emoji });
    }
  }
  if (canReply) {
    actions.push({ kind: 'reply', label: 'Reply' });
  }
  if (isOwnMessage) {
    actions.push({ kind: 'edit', label: 'Edit' }, { kind: 'delete', label: 'Delete' });
  }
  actions.push({ kind: 'cancel', label: 'Cancel' });

  const options = actions.map(action => action.label);
  const destructiveButtonIndex = isOwnMessage ? options.indexOf('Delete') : undefined;
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
