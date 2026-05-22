import { useEffect, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { getCornerRadiusSync } from 'expo-screen-corner-radius';
import { Text } from '@/components/ui/text';
import { formatTypingIndicatorText } from './typing-indicator-text';

const SCREEN_CORNER_RADIUS = getCornerRadiusSync() ?? 0;

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
  const horizontalPadding = keyboardVisible ? 0 : Math.round(SCREEN_CORNER_RADIUS * 0.4);

  return (
    <View className="h-5 justify-center" style={{ paddingHorizontal: horizontalPadding }}>
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
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => {
      setVisible(true);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}
