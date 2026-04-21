import { ActivityIndicator, View } from 'react-native';
import { AlertCircle, Check } from 'lucide-react-native';
import { type SessionStatusIndicator as SessionStatusIndicatorType } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const warningColor = 'hsl(38, 92%, 50%)';

type SessionStatusIndicatorProps = {
  indicator: SessionStatusIndicatorType;
};

export function SessionStatusIndicator({ indicator }: Readonly<SessionStatusIndicatorProps>) {
  return (
    <View className="flex-row items-center gap-2 px-4 py-2">
      <IndicatorContent indicator={indicator} />
    </View>
  );
}

function IndicatorContent({ indicator }: Readonly<SessionStatusIndicatorProps>) {
  const colors = useThemeColors();

  switch (indicator.type) {
    case 'error': {
      return (
        <View className="flex-row items-center gap-2">
          <AlertCircle size={14} color={colors.destructive} />
          <Text className="shrink text-sm text-destructive">{indicator.message}</Text>
        </View>
      );
    }
    case 'warning': {
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={warningColor} />
          <Text className="shrink text-sm text-amber-500">{indicator.message}</Text>
        </View>
      );
    }
    case 'progress': {
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">{indicator.message}</Text>
        </View>
      );
    }
    case 'info': {
      return (
        <View className="flex-row items-center gap-2">
          <Check size={14} color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">{indicator.message}</Text>
        </View>
      );
    }
    default: {
      return null;
    }
  }
}
