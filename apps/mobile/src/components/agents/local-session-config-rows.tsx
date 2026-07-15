import { Cpu, Server, Sparkles } from 'lucide-react-native';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { Text } from '@/components/ui/text';

export const SCREEN_TITLE = 'Local session';
const RUNTIME_ROW_TITLE = 'Runtime';
const AGENT_ROW_TITLE = 'Agent';
const MODEL_ROW_TITLE = 'Model';
export const SKELETON_ROW_CLASS = 'h-[54px] w-full rounded-lg';

type ConfiguredRowsProps = {
  runtimeTitle: string;
  runtimeSubtitle: string;
  onPressRuntime: () => void;
  agentTitle: string;
  agentSubtitle: string;
  onPressAgent: () => void;
  agentDisabled?: boolean;
  modelTitle: string;
  modelSubtitle: string;
  onPressModel: () => void;
  modelDisabled?: boolean;
  modelTrailing?: React.ReactNode;
};

export function ConfiguredRows({
  runtimeTitle,
  runtimeSubtitle,
  onPressRuntime,
  agentTitle,
  agentSubtitle,
  onPressAgent,
  agentDisabled,
  modelTitle,
  modelSubtitle,
  onPressModel,
  modelDisabled,
  modelTrailing,
}: ConfiguredRowsProps) {
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm shadow-black/5">
      <ConfigureRow
        icon={Server}
        title={RUNTIME_ROW_TITLE}
        subtitle={runtimeSubtitle}
        tone="good"
        onPress={onPressRuntime}
        trailing={
          <View className="flex-row items-center gap-2 pr-1">
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {runtimeTitle}
            </Text>
          </View>
        }
      />
      <ConfigureRow
        icon={Sparkles}
        title={AGENT_ROW_TITLE}
        subtitle={agentSubtitle}
        onPress={onPressAgent}
        disabled={agentDisabled}
        trailing={
          <View className="flex-row items-center gap-2 pr-1">
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {agentTitle}
            </Text>
          </View>
        }
      />
      <ConfigureRow
        icon={Cpu}
        title={MODEL_ROW_TITLE}
        subtitle={modelSubtitle}
        onPress={onPressModel}
        disabled={modelDisabled}
        last
        trailing={
          <View className="flex-row items-center gap-2 pr-1">
            {modelTrailing}
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {modelTitle}
            </Text>
          </View>
        }
      />
    </View>
  );
}
