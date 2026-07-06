import { type StoredMessage } from 'cloud-agent-sdk';
import { Pressable, View } from 'react-native';

import { Bubble } from '@/components/ui/bubble';

import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { MarkdownText } from './markdown-text';
import { PartRenderer } from './part-renderer';
import { isFilePart, isTextPart } from './part-types';
import { useMessageCopy } from './use-message-copy';

type MessageBubbleProps = {
  message: StoredMessage;
  isLastAssistantMessage?: boolean;
  isSessionStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  defaultReasoningExpanded?: boolean;
};

export function MessageBubble({
  message,
  isLastAssistantMessage,
  isSessionStreaming,
  getChildMessages,
  defaultReasoningExpanded,
}: Readonly<MessageBubbleProps>) {
  const isUser = message.info.role === 'user';
  const { copyMessage } = useMessageCopy();

  const handleLongPress = () => {
    void copyMessage(message);
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

    return (
      <Pressable
        onLongPress={handleLongPress}
        className="px-4 py-1"
        accessibilityRole="text"
        accessibilityLabel="User message"
        accessibilityHint="Long press to copy message text"
      >
        <Bubble side="user">
          {textContent ? <MarkdownText value={textContent} variant="user" /> : null}
          {fileParts.map(part => (
            <FilePartRenderer key={part.id} part={part} />
          ))}
        </Bubble>
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
    >
      <View className="gap-2">
        {message.parts.map(part => (
          <PartRenderer
            key={part.id}
            part={part}
            isStreaming={isStreaming}
            getChildMessages={getChildMessages}
            defaultReasoningExpanded={defaultReasoningExpanded}
          />
        ))}
      </View>
    </Pressable>
  );
}
