import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Eyebrow } from '@/components/ui/eyebrow';
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
    <View className="rounded-xl border-[1.5px] border-dashed border-border p-3">
      <Pressable
        className="flex-row items-center justify-between"
        onPress={() => {
          setIsExpanded(prev => !prev);
        }}
      >
        <Eyebrow>{isStreaming ? 'Thinking' : 'Thought'}</Eyebrow>
        {isExpanded ? (
          <ChevronDown size={14} color={colors.mutedSoft} />
        ) : (
          <ChevronRight size={14} color={colors.mutedSoft} />
        )}
      </Pressable>

      {isExpanded && text ? (
        <Animated.View entering={FadeIn.duration(200)} className="mt-2">
          <Text selectable className="text-sm leading-5 text-muted-foreground">
            {text}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
