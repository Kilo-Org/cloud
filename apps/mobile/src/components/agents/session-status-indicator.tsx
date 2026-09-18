import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { AlertCircle, Check } from '@/components/ui/icons';
import { type SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { localizeSdkMessage } from './sdk-message-copy';
import { sessionStatusErrorMessage } from './session-terminal-error';

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
      // English text. `sessionStatusErrorMessage` maps the known SDK and
      // delivery strings to translated copy and passes through the Durable
      // Object's safe failure projection unchanged.
      return (
        <View className="flex-row items-center gap-2">
          <AlertCircle size={14} color={colors.destructive} />
          <Text className="shrink text-sm text-destructive">
            {sessionStatusErrorMessage(indicator.message)}
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
      // The SDK's own progress lines (`Setting up environment…`, `Wrapping
      // up…`, the autocommit status) are pinned to catalog keys; anything the
      // SDK merely forwards is shown unchanged.
      return (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">
            {localizeSdkMessage(indicator.message)}
          </Text>
        </View>
      );
    }
    case 'info': {
      // As with progress: an SDK-pinned line (`Session stopped`) is localized,
      // an unrecognized one is shown as-is.
      return (
        <View className="flex-row items-center gap-2">
          <Check size={14} color={colors.mutedForeground} />
          <Text className="shrink text-sm text-muted-foreground">
            {localizeSdkMessage(indicator.message)}
          </Text>
        </View>
      );
    }
    default: {
      return null;
    }
  }
}
