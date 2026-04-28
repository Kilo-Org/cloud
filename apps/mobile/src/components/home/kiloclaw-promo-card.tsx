import { type Href, useRouter } from 'expo-router';
import { ChevronRight, MessageSquare } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const TITLE = 'KiloClaw';

export function KiloClawPromoCard() {
  const colors = useThemeColors();
  const router = useRouter();
  const tint = agentColor(TITLE);

  return (
    <Pressable
      onPress={() => {
        router.push('/(app)/onboarding' as Href);
      }}
      className="mx-4 gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
      accessibilityLabel="Create your KiloClaw agent"
    >
      <View className="flex-row items-start gap-3">
        <View
          className={cn(
            'h-10 w-10 items-center justify-center rounded-[10px] border',
            tint.tileBgClass,
            tint.tileBorderClass
          )}
        >
          <MessageSquare size={18} color={colors[tint.hueThemeKey]} />
        </View>
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-foreground">{TITLE}</Text>
          <Text variant="muted" className="mt-0.5 text-[13px]">
            Personal AI assistant
          </Text>
        </View>
      </View>
      <Text variant="muted" className="text-[14px] leading-5">
        Create your agent that reads email, manages your calendar, and takes action on your behalf.
      </Text>
      <View className="flex-row items-center justify-between">
        <Text className="font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          Create your agent
        </Text>
        <ChevronRight size={16} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
