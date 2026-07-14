import { Portal } from '@rn-primitives/portal';
import { X } from 'lucide-react-native';
import { useEffect } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const COMMON_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '🚀', '👀', '✅', '🔥', '🙏', '💡', '🤔'];

type MessageReactionPickerSheetProps = {
  visible: boolean;
  recentReactions: string[];
  onClose: () => void;
  onSelect: (emoji: string) => void;
};

function uniqueReactions(reactions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const reaction of reactions) {
    if (!seen.has(reaction)) {
      seen.add(reaction);
      result.push(reaction);
    }
  }
  return result;
}

export function MessageReactionPickerSheet({
  visible,
  recentReactions,
  onClose,
  onSelect,
}: Readonly<MessageReactionPickerSheetProps>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [visible, onClose]);

  if (!visible) {
    return null;
  }

  const recent = uniqueReactions(recentReactions).slice(0, 6);

  return (
    <Portal name="message-reactions">
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(150)}
        className="absolute inset-0 justify-end bg-black/40"
      >
        <Pressable className="flex-1" accessibilityLabel="Close reactions" onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(220)}
          exiting={SlideOutDown.duration(180)}
          accessibilityViewIsModal
          className="gap-4 rounded-t-3xl bg-card px-5 pt-4"
          style={{ paddingBottom: insets.bottom + 24 }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Reactions</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close reactions"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
              onPress={onClose}
            >
              <X size={18} color={colors.foreground} />
            </Pressable>
          </View>
          {recent.length > 0 ? (
            <ReactionGrid title="Recent" reactions={recent} onSelect={onSelect} />
          ) : null}
          <ReactionGrid title="Common" reactions={COMMON_REACTIONS} onSelect={onSelect} />
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}

function ReactionGrid({
  title,
  reactions,
  onSelect,
}: Readonly<{
  title: string;
  reactions: string[];
  onSelect: (emoji: string) => void;
}>) {
  return (
    <View className="gap-2">
      <Text variant="eyebrow">{title}</Text>
      <View className="flex-row flex-wrap gap-2">
        {reactions.map(reaction => (
          <Pressable
            key={reaction}
            accessibilityRole="button"
            accessibilityLabel={`React with ${reaction}`}
            className="h-11 w-11 items-center justify-center rounded-full bg-muted active:opacity-75"
            onPress={() => {
              onSelect(reaction);
            }}
          >
            <Text className="text-xl">{reaction}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
