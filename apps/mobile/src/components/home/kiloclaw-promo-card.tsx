import * as WebBrowser from 'expo-web-browser';
import { ArrowRight, MessageSquare } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function KiloClawPromoCard() {
  const colors = useThemeColors();

  return (
    <View className="mx-4 rounded-xl border border-border bg-card p-4 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <MessageSquare size={20} color={colors.foreground} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold">KiloClaw</Text>
          <Text variant="muted" className="text-xs">
            Personal AI assistant
          </Text>
        </View>
      </View>
      <Text variant="muted" className="text-sm">
        Create your agent that reads email, manages your calendar, and takes action on your behalf.
      </Text>
      <Button
        variant="outline"
        onPress={() => {
          void WebBrowser.openBrowserAsync('https://app.kilo.ai/claw');
        }}
      >
        <Text>Create your agent</Text>
        <ArrowRight size={16} color={colors.foreground} />
      </Button>
    </View>
  );
}
