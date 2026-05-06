import { type Message } from '@kilocode/kilo-chat';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { canShowReactionPills } from './message-presentation';

type MessageReactionPillsProps = {
  message: Message;
  currentUserId: string | null;
  isFromMe: boolean;
  onReactionPress: (message: Message, emoji: string) => void;
};

export function MessageReactionPills({
  message,
  currentUserId,
  isFromMe,
  onReactionPress,
}: Readonly<MessageReactionPillsProps>) {
  if (!canShowReactionPills(message)) {
    return null;
  }

  return (
    <View
      className={cn(
        'mt-1 flex-row flex-wrap gap-1 px-1',
        isFromMe ? 'justify-end' : 'justify-start'
      )}
    >
      {message.reactions.map(reaction => {
        const hasReacted = currentUserId ? reaction.memberIds.includes(currentUserId) : false;
        return (
          <Pressable
            key={reaction.emoji}
            onPress={() => {
              onReactionPress(message, reaction.emoji);
            }}
            className={cn(
              'min-h-11 flex-row items-center gap-1 rounded-full px-3 py-1',
              hasReacted ? 'bg-primary' : 'bg-neutral-200 dark:bg-neutral-700'
            )}
          >
            <Text className="text-sm">{reaction.emoji}</Text>
            <Text
              className={cn(
                'text-xs font-medium',
                hasReacted ? 'text-primary-foreground' : 'text-foreground'
              )}
            >
              {reaction.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
