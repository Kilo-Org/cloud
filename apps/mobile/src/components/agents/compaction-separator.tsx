import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type MessageInfo } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

function compactionStatusKey(info: MessageInfo | undefined, isStreaming: boolean) {
  if (info?.role === 'assistant') {
    if (info.error?.name === 'MessageAbortedError') {
      return 'common.cancelled';
    }
    if (info.error) {
      return 'common.failed';
    }
    if (info.time.completed === undefined) {
      return isStreaming ? 'common.running' : 'common.cancelled';
    }
  }
  return 'agentChat.compaction.contextCompacted';
}

export function CompactionSeparator({
  info,
  isStreaming = false,
}: {
  info?: MessageInfo;
  isStreaming?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 py-3">
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
      <Text className="font-mono-medium text-[11px] uppercase tracking-[1px] text-muted-foreground">
        {t(compactionStatusKey(info, isStreaming))}
      </Text>
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
    </View>
  );
}
