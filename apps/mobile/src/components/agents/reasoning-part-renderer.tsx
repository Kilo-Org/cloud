import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Brain, ChevronDown } from 'lucide-react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ReasoningPartRendererProps = {
  text: string;
  isStreaming?: boolean;
};

export function ReasoningPartRenderer({ text, isStreaming }: Readonly<ReasoningPartRendererProps>) {
  const [isExpanded, setIsExpanded] = useState(false);
  const colors = useThemeColors();

  return (
    <View className="gap-1">
      <Pressable
        className="flex-row items-center gap-2 py-1"
        onPress={() => {
          setIsExpanded(prev => !prev);
        }}
      >
        <Brain size={14} color={colors.mutedForeground} />
        <Text className="text-sm text-muted-foreground">
          {isStreaming ? 'Thinking…' : 'Thought'}
        </Text>
        <View className={isExpanded ? 'rotate-180' : undefined}>
          <ChevronDown size={14} color={colors.mutedForeground} />
        </View>
      </Pressable>

      {isExpanded && text ? (
        <Animated.View entering={FadeIn.duration(200)}>
          <View className="rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
            <Text selectable className="text-sm leading-5 text-muted-foreground">
              {text}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}
