import { useEffect, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { formatTypingIndicatorText } from './typing-indicator-text';

type Props = {
  botName?: string | null;
  typingMembers: Map<string, number>;
};

export function TypingIndicator({ botName, typingMembers }: Props) {
  const text = formatTypingIndicatorText({
    botName,
    typingMemberIds: [...typingMembers.keys()],
  });
  const keyboardVisible = useKeyboardVisible();

  return (
    <View className={cn('h-5 justify-center', !keyboardVisible && 'px-7')}>
      {text ? (
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {text}
        </Text>
      ) : null}
    </View>
  );
}

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => {
      setVisible(true);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      setVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}
