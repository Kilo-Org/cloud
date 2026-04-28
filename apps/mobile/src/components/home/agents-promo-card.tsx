import { type Href, useRouter } from 'expo-router';
import { Bot, ChevronRight } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const TITLE = 'Kilo Agents';

type AgentsPromoCardProps = {
  organizationId: string | null;
};

export function AgentsPromoCard({ organizationId }: Readonly<AgentsPromoCardProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const tint = agentColor(TITLE);

  return (
    <Pressable
      onPress={() => {
        const path = organizationId
          ? `/(app)/agent-chat/new?organizationId=${organizationId}`
          : '/(app)/agent-chat/new';
        router.push(path as Href);
      }}
      className="mx-4 gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
      accessibilityLabel="Start a new Kilo Agent session"
    >
      <View className="flex-row items-start gap-3">
        <View
          className={cn(
            'h-10 w-10 items-center justify-center rounded-[10px] border',
            tint.tileBgClass,
            tint.tileBorderClass
          )}
        >
          <Bot size={18} color={colors[tint.hueThemeKey]} />
        </View>
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-foreground">{TITLE}</Text>
          <Text variant="muted" className="mt-0.5 text-[13px]">
            AI coding sessions
          </Text>
        </View>
      </View>
      <Text variant="muted" className="text-[14px] leading-5">
        Start a coding task from your phone or continue a session from your CLI.
      </Text>
      <View className="flex-row items-center justify-between">
        <Text className="font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          Try it
        </Text>
        <ChevronRight size={16} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
