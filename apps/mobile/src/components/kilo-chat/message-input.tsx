import { useCallback, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Send } from 'lucide-react-native';

import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type MessageInputProps = {
  onSend: (text: string) => void;
  isSending: boolean;
};

const COUNTER_SHOW_AT = Math.floor(MESSAGE_TEXT_MAX_CHARS * 0.8);

export function MessageInput({ onSend, isSending }: Readonly<MessageInputProps>) {
  const colors = useThemeColors();
  const textRef = useRef('');
  const [charCount, setCharCount] = useState(0);
  const [canSend, setCanSend] = useState(false);

  const handleChangeText = useCallback((text: string) => {
    textRef.current = text;
    setCharCount(text.length);
    setCanSend(text.trim().length > 0 && text.length <= MESSAGE_TEXT_MAX_CHARS);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = textRef.current.trim();
    if (!trimmed || isSending || charCount > MESSAGE_TEXT_MAX_CHARS) {
      return;
    }
    onSend(trimmed);
    textRef.current = '';
    setCharCount(0);
    setCanSend(false);
  }, [onSend, isSending, charCount]);

  const overLimit = charCount > MESSAGE_TEXT_MAX_CHARS;
  const showCounter = charCount >= COUNTER_SHOW_AT;
  const sendDisabled = !canSend || isSending;

  return (
    <View className="border-t border-border">
      <View className="flex-row items-end gap-2 p-3">
        <TextInput
          className="flex-1 border border-input bg-background rounded-lg px-3 py-2 text-sm text-foreground leading-5 max-h-32"
          placeholder="Type a message..."
          placeholderTextColor={colors.mutedForeground}
          onChangeText={handleChangeText}
          multiline
          returnKeyType="default"
          editable={!isSending}
        />
        <Pressable
          className={cn(
            'bg-primary rounded-lg p-2 items-center justify-center',
            sendDisabled && 'opacity-50'
          )}
          onPress={handleSend}
          disabled={sendDisabled}
          accessibilityLabel="Send message"
        >
          <Send size={18} color={colors.primaryForeground} />
        </Pressable>
      </View>
      {showCounter ? (
        <View className="px-4 pb-2 items-end">
          <Text className={`text-xs ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
            {charCount.toLocaleString('en-US')} / {MESSAGE_TEXT_MAX_CHARS.toLocaleString('en-US')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
