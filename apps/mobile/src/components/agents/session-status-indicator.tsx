import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { AlertCircle, Check } from '@/components/ui/icons';
import { type SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { sessionStatusErrorMessage, statusCopyKeyForCode } from './session-terminal-error';

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
  const { t } = useTranslation();

  switch (indicator.type) {
    case 'error': {
      // The SDK message is usually the provider's or the transport's own
      // English text. `sessionStatusErrorMessage` maps a code to translated
      // copy, classifies a known string, and passes through the Durable
      // Object's safe failure projection unchanged.
      return (
        <View className="flex-row items-center gap-2">
          <AlertCircle size={14} color={colors.destructive} />
          <Text className="shrink text-sm text-destructive">
            {sessionStatusErrorMessage(indicator)}
          </Text>
        </View>
      );
    }
    case 'warning': {
      // Warning is the agent's own retry after a transient provider failure.
      // Its message is that failure's raw text, so the reader gets fixed copy.
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.warn} />
          <Text className="shrink text-sm text-warn">{t('agentChat.permissionCard.retrying')}</Text>
        </View>
      );
    }
    case 'progress': {
      // A code labels SDK-written copy, which the reader gets in their own
      // language; autocommit event text carries no code and stays as it is.
      const copyKey = indicator.code ? statusCopyKeyForCode(indicator.code) : undefined;
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">
            {copyKey ? t(copyKey) : indicator.message}
          </Text>
        </View>
      );
    }
    case 'info': {
      const copyKey = indicator.code ? statusCopyKeyForCode(indicator.code) : undefined;
      return (
        <View className="flex-row items-center gap-2">
          <Check size={14} color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">
            {copyKey ? t(copyKey) : indicator.message}
          </Text>
        </View>
      );
    }
    default: {
      return null;
    }
  }
}
