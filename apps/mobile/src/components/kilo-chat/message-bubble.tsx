import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { MessageMarkdown } from './message-markdown';
import {
  canShowReactionPills,
  getDeliveryFailureLabel,
  getReplyPreviewText,
  isMessageEdited,
  type ReplyPreviewSource,
} from './message-presentation';

type Props = {
  message: Message;
  currentUserId: string | null;
  isFromMe: boolean;
  showAuthor: boolean;
  pendingActionGroupId: string | null;
  replyToMessage?: ReplyPreviewSource | null;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
  onReactionPress: (message: Message, emoji: string) => void;
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

function MessageBubbleComponent({
  message,
  currentUserId,
  isFromMe,
  showAuthor,
  pendingActionGroupId,
  replyToMessage,
  onExecuteAction,
  onReactionPress,
  onLongPress,
}: Props) {
  const colors = useThemeColors();
  const isPending = message.id.startsWith('pending-');
  const timestamp = message.clientUpdatedAt ?? message.updatedAt;
  const edited = isMessageEdited(message);
  const authorLabel = message.senderId.startsWith('bot:') ? 'KiloClaw' : message.senderId;

  function handleReactionPress(emoji: string) {
    onReactionPress(message, emoji);
  }

  function handleExecuteAction(groupId: string, value: ExecApprovalDecision) {
    onExecuteAction(message, groupId, value);
  }

  const textColor = isFromMe ? 'text-primary-foreground' : 'text-foreground';
  const deliveryFailureLabel = getDeliveryFailureLabel(message);

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
          <Text className="text-xs font-medium text-muted-foreground">{authorLabel}</Text>
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
            {replyToMessage && (
              <View
                className={cn(
                  'mb-2 border-l-2 py-1 pl-2',
                  isFromMe ? 'border-primary-foreground' : 'border-muted-foreground'
                )}
              >
                <Text numberOfLines={2} className={cn('text-xs opacity-80', textColor)}>
                  {getReplyPreviewText(replyToMessage)}
                </Text>
              </View>
            )}
            {message.content.map((block, index) => {
              if (block.type === 'text') {
                return <MessageMarkdown key={index} text={block.text} isFromMe={isFromMe} />;
              }

              // block.type === 'actions'
              if (block.resolved) {
                const resolvedAction = block.actions.find(a => a.value === block.resolved?.value);
                const label = resolvedAction?.label ?? block.resolved.value;
                const Icon = block.resolved.value.startsWith('allow') ? CheckCircle2 : XCircle;
                return (
                  <View key={block.groupId} className="mt-2 flex-row items-center gap-1.5">
                    <Icon
                      size={14}
                      color={isFromMe ? colors.primaryForeground : colors.mutedForeground}
                    />
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
                      disabled={pendingActionGroupId === block.groupId}
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
            {deliveryFailureLabel && (
              <View className="mt-2 flex-row items-center gap-1.5">
                <AlertCircle size={14} color={colors.destructive} />
                <Text className="text-xs font-medium text-red-600 dark:text-red-400">
                  {deliveryFailureLabel}
                </Text>
              </View>
            )}
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
            {edited ? ' (edited)' : ''}
          </Text>
        )}
      </View>

      {canShowReactionPills(message) && (
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
      )}
    </Pressable>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
