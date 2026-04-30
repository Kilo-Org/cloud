import {
  useAddReaction,
  useExecuteAction,
  useKiloChatClient,
  useRemoveReaction,
} from '@kilocode/kilo-chat-hooks';
import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { cn } from '@/lib/utils';

type Props = {
  message: Message;
  conversationId: string;
  isFromMe: boolean;
  showAuthor: boolean;
  onLongPress?: (m: Message) => void;
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function actionStyleToVariant(
  style: 'primary' | 'danger' | 'secondary'
): 'default' | 'destructive' | 'secondary' {
  if (style === 'danger') {
    return 'destructive';
  }
  if (style === 'secondary') {
    return 'secondary';
  }
  return 'default';
}

export function MessageBubble({
  message,
  conversationId,
  isFromMe,
  showAuthor,
  onLongPress,
}: Props) {
  const client = useKiloChatClient();
  const currentUserId = useCurrentUserId();

  const executeAction = useExecuteAction(client, conversationId, currentUserId ?? '');
  const addReaction = useAddReaction(client, conversationId, currentUserId ?? '');
  const removeReaction = useRemoveReaction(client, conversationId, currentUserId ?? '');

  const isPending = message.id.startsWith('pending-');
  const timestamp = message.clientUpdatedAt ?? message.updatedAt;

  function handleReactionPress(emoji: string) {
    if (!currentUserId) {
      return;
    }
    const hasReacted = message.reactions
      .find(r => r.emoji === emoji)
      ?.memberIds.includes(currentUserId);
    if (hasReacted) {
      removeReaction.mutate({ messageId: message.id, emoji });
    } else {
      addReaction.mutate({ messageId: message.id, emoji });
    }
  }

  function handleExecuteAction(groupId: string, value: ExecApprovalDecision) {
    executeAction.mutate({ messageId: message.id, groupId, value });
  }

  const textColor = isFromMe ? 'text-primary-foreground' : 'text-foreground';

  return (
    <Pressable
      onLongPress={
        onLongPress
          ? () => {
              onLongPress(message);
            }
          : undefined
      }
      className={cn('px-4 py-1', isFromMe ? 'items-end' : 'items-start', isPending && 'opacity-50')}
    >
      {showAuthor && (
        <View className="mb-0.5 flex-row items-baseline gap-2 px-1">
          <Text className="text-xs font-medium text-muted-foreground">{message.senderId}</Text>
          {timestamp !== null && (
            <Text className="text-[10px] text-muted-foreground">{formatTimestamp(timestamp)}</Text>
          )}
        </View>
      )}

      <View
        className={cn(
          'max-w-[80%] rounded-2xl px-3 py-2',
          isFromMe ? 'bg-primary' : 'bg-neutral-100 dark:bg-neutral-800'
        )}
      >
        {message.deleted ? (
          <Text className={cn('text-sm italic opacity-50', textColor)}>[deleted message]</Text>
        ) : (
          <>
            {message.content.map((block, index) => {
              if (block.type === 'text') {
                return (
                  <Text key={index} selectable className={cn('text-sm leading-5', textColor)}>
                    {block.text}
                  </Text>
                );
              }

              // block.type === 'actions'
              if (block.resolved) {
                const resolvedAction = block.actions.find(a => a.value === block.resolved?.value);
                const label = resolvedAction?.label ?? block.resolved.value;
                return (
                  <View key={block.groupId} className="mt-2 flex-row items-center gap-1.5">
                    <Text className={cn('text-xs opacity-70', textColor)}>{label}</Text>
                  </View>
                );
              }

              return (
                <View key={block.groupId} className="mt-2 flex-row flex-wrap gap-2">
                  {block.actions.map(action => (
                    <Button
                      key={action.value}
                      variant={actionStyleToVariant(action.style)}
                      size="sm"
                      disabled={executeAction.isPending}
                      onPress={() => {
                        handleExecuteAction(block.groupId, action.value);
                      }}
                    >
                      <Text>{action.label}</Text>
                    </Button>
                  ))}
                </View>
              );
            })}
          </>
        )}

        {!showAuthor && timestamp !== null && (
          <Text
            className={cn(
              'mt-1 text-right text-[10px]',
              isFromMe ? 'text-primary-foreground opacity-70' : 'text-muted-foreground'
            )}
          >
            {formatTimestamp(timestamp)}
          </Text>
        )}
      </View>

      {message.reactions.length > 0 && (
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
                  handleReactionPress(reaction.emoji);
                }}
                className={cn(
                  'flex-row items-center gap-0.5 rounded-full px-2 py-0.5',
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
      )}
    </Pressable>
  );
}
