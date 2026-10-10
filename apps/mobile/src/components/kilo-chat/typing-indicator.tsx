import { View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
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
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const horizontalPadding = keyboardVisible ? 0 : Math.round(SCREEN_CORNER_RADIUS * 0.4);

  if (!text) {
    return null;
  }

  return (
    <View className="h-5 justify-center" style={{ paddingHorizontal: horizontalPadding }}>
      <Text numberOfLines={1} className="text-xs text-muted-foreground">
        {text}
      </Text>
    </View>
  );
}
