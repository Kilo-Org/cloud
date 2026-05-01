export const FIRST_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const;

type BuildMessageActionSheetOptionsInput = {
  isOwnMessage: boolean;
  canReact: boolean;
};

export function buildMessageActionSheetOptions({
  isOwnMessage,
  canReact,
}: BuildMessageActionSheetOptionsInput): {
  options: string[];
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
} {
  const options = [
    ...(canReact ? FIRST_REACTION_EMOJIS.map(emoji => `${emoji} React`) : []),
    ...(isOwnMessage ? ['Edit', 'Delete'] : []),
    'Cancel',
  ];
  const destructiveButtonIndex = isOwnMessage ? options.indexOf('Delete') : undefined;
  return {
    options,
    cancelButtonIndex: options.length - 1,
    ...(destructiveButtonIndex !== undefined && { destructiveButtonIndex }),
  };
}
