import { useMemo } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Check, Cloud, Server } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dedupeInstanceLabels, type LabeledInstance } from '@/lib/instance-picker-rows';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

type RunTargetStepProps = {
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  onSelectTarget: (instance: InstancePickerInstance | null) => void;
};

/**
 * Step 1 of the new-session steps flow: pick a run target. Cloud Agent is
 * always first, followed by one row per deduped CLI instance with the
 * optional `#dedupSuffix` label. Tapping a row invokes the existing
 * target-change handler, plays a light haptic, and the route advances to
 * step 2.
 */
export function RunTargetStep({
  runOnInstance,
  instanceList,
  onSelectTarget,
}: Readonly<RunTargetStepProps>) {
  const colors = useThemeColors();

  const labeled: LabeledInstance[] = useMemo(
    () => dedupeInstanceLabels(instanceList),
    [instanceList]
  );

  const currentConnectionId = runOnInstance?.connectionId ?? null;

  function handleSelectCloudAgent() {
    void Haptics.selectionAsync();
    onSelectTarget(null);
  }

  function handleSelectInstance(instance: InstancePickerInstance) {
    void Haptics.selectionAsync();
    onSelectTarget(instance);
  }

  const renderItem = ({ item }: { item: LabeledInstance }) => {
    const selected = item.connectionId === currentConnectionId;
    return (
      <Pressable
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
        onPress={() => {
          handleSelectInstance(item);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          item.dedupSuffix
            ? `${item.name} on ${item.projectName} (${item.dedupSuffix})`
            : `${item.name} on ${item.projectName}`
        }
      >
        <Server size={18} color={colors.foreground} />
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            {item.dedupSuffix ? (
              <Text variant="mono" className="text-xs text-muted-foreground">
                #{item.dedupSuffix}
              </Text>
            ) : null}
          </View>
          <Text variant="muted" className="text-sm" numberOfLines={1}>
            {item.projectName}
          </Text>
        </View>
        {selected ? <Check size={18} color={colors.primary} /> : null}
      </Pressable>
    );
  };

  return (
    <FlatList
      className="flex-1 bg-background"
      data={labeled}
      keyExtractor={item => item.connectionId}
      contentContainerClassName="flex-grow"
      ListHeaderComponent={
        <Pressable
          className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
          onPress={handleSelectCloudAgent}
          accessibilityRole="button"
          accessibilityLabel="Run on Cloud Agent"
        >
          <Cloud size={18} color={colors.foreground} />
          <View className="flex-1">
            <Text className="text-base font-medium text-foreground">Cloud Agent</Text>
            <Text variant="muted" className="text-sm">
              Run on Kilo's cloud sandbox
            </Text>
          </View>
          {currentConnectionId === null ? <Check size={18} color={colors.primary} /> : null}
        </Pressable>
      }
      ListEmptyComponent={null}
      renderItem={renderItem}
    />
  );
}
