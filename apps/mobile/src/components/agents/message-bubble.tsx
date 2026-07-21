import { type MessageDeliveryState, type StoredMessage } from 'cloud-agent-sdk';
import { Clock } from 'lucide-react-native';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Bubble } from '@/components/ui/bubble';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { ChatMarkdownText } from './chat-markdown-text';
import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { PartRenderer } from './part-renderer';
import { isFilePart, isTextPart } from './part-types';
import { useMessageCopy } from './use-message-copy';
import { type OpenChildSession } from './child-session-section';

type MessageBubbleProps = {
  message: StoredMessage;
  isLastAssistantMessage?: boolean;
  isSessionStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  defaultReasoningExpanded?: boolean;
  onOpenChildSession?: OpenChildSession;
  /** Per-user-message delivery state. v1 surfaces only a "Queued" badge. */
  deliveryState?: MessageDeliveryState;
};

export function MessageBubble({
  message,
  isLastAssistantMessage,
  isSessionStreaming,
  getChildMessages,
  defaultReasoningExpanded,
  onOpenChildSession,
  deliveryState,
}: Readonly<MessageBubbleProps>) {
  const isUser = message.info.role === 'user';
  const { copyMessage } = useMessageCopy();
  const colors = useThemeColors();

  const handleLongPress = () => {
    void copyMessage(message);
  };

  // Long-press is an accelerator; expose the same "copy" action to
  // accessibility tooling (VoiceOver/TalkBack rotor) since a long-press
  // gesture isn't reliably discoverable there.
  const copyAccessibilityActions = [{ name: 'copy', label: 'Copy message' }];
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'copy') {
      void copyMessage(message);
    }
  };

  // Compaction-only message renders as a separator
  const firstPart = message.parts[0];
  if (message.parts.length === 1 && firstPart?.type === 'compaction') {
    return (
      <View className="px-4">
        <CompactionSeparator />
      </View>
    );
  }

  if (isUser) {
    const textContent = message.parts
      .filter(isTextPart)
      .map(p => p.text)
      .join('');
    const fileParts = message.parts.filter(isFilePart);
    const showQueuedBadge = deliveryState?.status === 'queued';

    return (
      <Pressable
        onLongPress={handleLongPress}
        className="px-4 py-1"
        accessibilityRole="text"
        accessibilityLabel="User message"
        accessibilityHint="Long press to copy message text"
        accessibilityActions={copyAccessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
      >
        <View className="items-end gap-1">
          <Bubble side="user">
            {textContent ? (
              <ChatMarkdownText value={textContent} variant="user" selectable={false} />
            ) : null}
            {fileParts.map(part => (
              <FilePartRenderer key={part.id} part={part} />
            ))}
          </Bubble>
          {showQueuedBadge ? (
            <Animated.View
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(120)}
              accessibilityRole="text"
              accessibilityLabel="Message queued"
              className="flex-row items-center gap-1 self-end pr-1"
            >
              <Clock size={12} color={colors.mutedForeground} />
              <Text className="text-xs text-muted-foreground">Queued</Text>
            </Animated.View>
          ) : null}
        </View>
      </Pressable>
    );
  }

  // Assistant messages: render parts sequentially without a bubble
  const isStreaming = isLastAssistantMessage && isSessionStreaming;

  return (
    <Pressable
      className="px-4 py-2"
      onLongPress={handleLongPress}
      accessibilityRole="text"
      accessibilityLabel="Assistant message"
      accessibilityHint="Long press to copy message text"
      accessibilityActions={copyAccessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
    >
      <View className="gap-2">
        {message.parts.map(part => (
          <PartRenderer
            key={part.id}
            part={part}
            isStreaming={isStreaming}
            getChildMessages={getChildMessages}
            defaultReasoningExpanded={defaultReasoningExpanded}
            onOpenChildSession={onOpenChildSession}
          />
        ))}
      </View>
    </Pressable>
  );
}
