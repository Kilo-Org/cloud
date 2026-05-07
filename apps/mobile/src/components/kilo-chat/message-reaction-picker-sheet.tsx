import { Portal } from '@rn-primitives/portal';
import { X } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

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
  if (!visible) {
    return null;
  }

  const recent = uniqueReactions(recentReactions).slice(0, 6);

  return (
    <Portal name="message-reactions">
      <View className="absolute inset-0 justify-end bg-black/40">
        <Pressable className="flex-1" accessibilityLabel="Close reactions" onPress={onClose} />
        <View className="gap-4 rounded-t-3xl bg-card px-5 pb-8 pt-4">
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
        </View>
      </View>
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
