/* eslint-disable max-lines */
import { memo, useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { AlertCircle, Check, Reply, X } from 'lucide-react-native';

import { contentBlocksToText, type Message, ulidToTimestamp } from '@kilocode/kilo-chat';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type MessageBubbleProps = {
  message: Message;
  isOwn: boolean;
  currentUserId: string;
  onEdit: (messageId: string, text: string) => void;
  onDelete: (messageId: string) => void;
  onAddReaction: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;
};

function formatTimestamp(messageId: string, isOptimistic: boolean): string {
  const ts = isOptimistic ? Date.now() : ulidToTimestamp(messageId);
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isOwn,
  currentUserId,
  onEdit,
  onDelete,
  onAddReaction,
  onRemoveReaction,
}: Readonly<MessageBubbleProps>) {
  const colors = useThemeColors();
  const isBot = message.senderId.startsWith('bot:');
  const isOptimistic = message.id.startsWith('pending-');
  const textContent = message.deleted ? '' : contentBlocksToText(message.content);
  const timeStr = formatTimestamp(message.id, isOptimistic);

  const handleLongPress = useCallback(() => {
    if (message.deleted) {
      return;
    }
    const options: { text: string; onPress: () => void; style?: 'destructive' | 'cancel' }[] = [
      { text: 'Cancel', style: 'cancel', onPress: () => undefined },
    ];
    if (isOwn && !message.deliveryFailed) {
      options.unshift({
        text: 'Edit',
        onPress: () => {
          onEdit(message.id, textContent);
        },
      });
    }
    if (isOwn) {
      options.unshift({
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Alert.alert('Delete message?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                onDelete(message.id);
              },
            },
          ]);
        },
      });
    }
    Alert.alert('Message', undefined, options);
  }, [message, isOwn, textContent, onEdit, onDelete]);

  const handleReactionToggle = useCallback(
    (emoji: string) => {
      const alreadyReacted = message.reactions
        .find(r => r.emoji === emoji)
        ?.memberIds.includes(currentUserId);
      if (alreadyReacted) {
        onRemoveReaction(message.id, emoji);
      } else {
        onAddReaction(message.id, emoji);
      }
    },
    [message.id, message.reactions, currentUserId, onAddReaction, onRemoveReaction]
  );

  const actionBlocks = message.deleted ? [] : message.content.filter(b => b.type === 'actions');

  return (
    <View className={cn('px-4 py-1', isOwn ? 'items-end' : 'items-start')}>
      <View className="max-w-[80%] min-w-0">
        {isBot && !isOwn ? (
          <Text className="text-xs font-medium text-muted-foreground mb-1 px-1">Bot</Text>
        ) : null}

        {message.inReplyToMessageId ? (
          <View className="flex-row items-center gap-1 px-1 mb-1">
            <Reply size={12} color={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              Reply to message
            </Text>
          </View>
        ) : null}

        <Pressable onLongPress={handleLongPress}>
          <View
            className={cn(
              'rounded-2xl px-3 py-2 overflow-hidden',
              isOwn ? 'bg-primary' : 'bg-muted'
            )}
          >
            {message.deleted ? (
              <Text className="text-sm italic opacity-50 text-foreground">[deleted message]</Text>
            ) : (
              <Text
                className={cn('text-sm', isOwn ? 'text-primary-foreground' : 'text-foreground')}
              >
                {textContent}
              </Text>
            )}

            {actionBlocks.map(block => {
              if (block.resolved) {
                const resolvedAction = block.actions.find(a => a.value === block.resolved?.value);
                const label = resolvedAction?.label ?? block.resolved.value;
                const isApproved = block.resolved.value !== 'deny';
                return (
                  <View key={block.groupId} className="flex-row items-center gap-1 mt-2">
                    {isApproved ? (
                      <Check size={12} color={colors.mutedForeground} />
                    ) : (
                      <X size={12} color={colors.mutedForeground} />
                    )}
                    <Text className="text-xs text-muted-foreground">{label}</Text>
                  </View>
                );
              }
              return null;
            })}

            <View className="mt-1 flex-row gap-1 justify-end">
              {message.deliveryFailed ? (
                <View className="flex-row items-center gap-1">
                  <AlertCircle size={10} color={colors.destructive} />
                  <Text className="text-[10px] text-destructive">Not delivered</Text>
                </View>
              ) : null}
              {message.clientUpdatedAt && !message.deleted ? (
                <Text
                  className={cn(
                    'text-[10px]',
                    isOwn ? 'text-primary-foreground' : 'text-muted-foreground'
                  )}
                >
                  (edited)
                </Text>
              ) : null}
              <Text
                className={cn(
                  'text-[10px]',
                  isOwn ? 'text-primary-foreground' : 'text-muted-foreground'
                )}
              >
                {timeStr}
              </Text>
            </View>
          </View>
        </Pressable>

        {!message.deleted && !message.deliveryFailed && message.reactions.length > 0 ? (
          <View
            className={cn('flex-row flex-wrap gap-1 mt-1', isOwn ? 'justify-end' : 'justify-start')}
          >
            {message.reactions.map(r => {
              const isMine = r.memberIds.includes(currentUserId);
              return (
                <Pressable
                  key={r.emoji}
                  onPress={() => {
                    handleReactionToggle(r.emoji);
                  }}
                  className={cn(
                    'flex-row items-center gap-1 rounded-full px-2 py-0.5 border',
                    isMine
                      ? 'bg-neutral-200 border-neutral-400 dark:bg-neutral-700 dark:border-neutral-500'
                      : 'bg-muted border-border'
                  )}
                >
                  <Text className="text-sm">{r.emoji}</Text>
                  <Text
                    className={cn(
                      'text-xs',
                      isMine ? 'font-bold text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {String(r.count)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </View>
  );
});
