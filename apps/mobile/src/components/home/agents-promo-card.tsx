import { type Href, useRouter } from 'expo-router';
import { ArrowRight, Bot } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function AgentsPromoCard() {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <View className="mx-4 rounded-xl border border-border bg-card p-4 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Bot size={20} color={colors.foreground} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold">Kilo Agents</Text>
          <Text variant="muted" className="text-xs">
            AI coding sessions
          </Text>
        </View>
      </View>
      <Text variant="muted" className="text-sm">
        Start a coding task from your phone or continue a session from your CLI.
      </Text>
      <Button
        variant="outline"
        onPress={() => {
          router.push('/(app)/(tabs)/(2_agents)' as Href);
        }}
      >
        <Text>Get started</Text>
        <ArrowRight size={16} color={colors.foreground} />
      </Button>
    </View>
  );
}
