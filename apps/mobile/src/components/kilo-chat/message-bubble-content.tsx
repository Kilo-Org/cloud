import { type ExecApprovalDecision, type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { MessageAttachment } from './message-attachment';
import { MessageMarkdown } from './message-markdown';
import {
  getDeliveryFailureLabel,
  getReplyPreviewText,
  type ReplyPreviewSource,
} from './message-presentation';

type Props = {
  client: KiloChatClient;
  conversationId: string;
  message: Message;
  isFromMe: boolean;
  pendingActionGroupId: string | null;
  replyToMessage?: ReplyPreviewSource | null;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
};

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

export function MessageBubbleContent({
  client,
  conversationId,
  message,
  isFromMe,
  pendingActionGroupId,
  replyToMessage,
  onExecuteAction,
}: Props) {
  const colors = useThemeColors();
  const textColor = isFromMe ? 'text-primary-foreground' : 'text-foreground';
  const deliveryFailureLabel = getDeliveryFailureLabel(message);

  function handleExecuteAction(groupId: string, value: ExecApprovalDecision) {
    onExecuteAction(message, groupId, value);
  }

  if (message.deleted) {
    return <Text className={cn('text-sm italic opacity-50', textColor)}>[deleted message]</Text>;
  }

  return (
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

        if (block.type === 'attachment') {
          return (
            <MessageAttachment
              key={block.attachmentId}
              client={client}
              conversationId={conversationId}
              block={block}
              isFromMe={isFromMe}
            />
          );
        }

        if (block.resolved) {
          const resolvedAction = block.actions.find(
            action => action.value === block.resolved?.value
          );
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
  );
}
