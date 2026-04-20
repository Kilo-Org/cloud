import { useCallback } from 'react';
import { ActionSheetIOS, Platform, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { type StoredMessage } from 'cloud-agent-sdk';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';

import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { PartRenderer } from './part-renderer';
import { isFilePart, isTextPart } from './part-types';

type MessageBubbleProps = {
  message: StoredMessage;
  isLastAssistantMessage?: boolean;
  isSessionStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
};

export function MessageBubble({
  message,
  isLastAssistantMessage,
  isSessionStreaming,
  getChildMessages,
}: Readonly<MessageBubbleProps>) {
  const isUser = message.info.role === 'user';

  const handleLongPress = useCallback(() => {
    const textContent = message.parts
      .filter(isTextPart)
      .map(p => p.text)
      .join('\n');
    if (!textContent) {
      return;
    }

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Copy Text', 'Cancel'], cancelButtonIndex: 1 },
        buttonIndex => {
          if (buttonIndex === 0) {
            void Clipboard.setStringAsync(textContent);
            toast.success('Copied to clipboard');
          }
        }
      );
    } else {
      void Clipboard.setStringAsync(textContent);
      toast.success('Copied to clipboard');
    }
  }, [message.parts]);

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
      <View className="items-end px-4 py-1">
        <View
          className="max-w-[85%] rounded-2xl bg-primary px-3.5 py-2.5"
          // eslint-disable-next-line react-native/no-inline-styles -- NativeWind has no className for borderCurve
          style={{ borderCurve: 'continuous' }}
        >
          {textContent ? (
            <Text className="text-base leading-6 text-primary-foreground">{textContent}</Text>
          ) : null}
          {fileParts.map(part => (
            <FilePartRenderer key={part.id} part={part} />
          ))}
        </View>
      </View>
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
      accessibilityHint="Long press to copy text"
    >
      <View className="gap-2">
        {message.parts.map(part => (
          <PartRenderer
            key={part.id}
            part={part}
            isStreaming={isStreaming}
            getChildMessages={getChildMessages}
          />
        ))}
      </View>
    </Pressable>
  );
}
