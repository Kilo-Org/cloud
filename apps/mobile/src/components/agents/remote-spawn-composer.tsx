import { ActivityIndicator, ScrollView, View } from 'react-native';

import { InstanceSelector } from '@/components/agents/instance-selector';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RemoteSpawnComposerProps = {
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  isLoadingInstances: boolean;
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  isSpawningRemote: boolean;
  isStartDisabled: boolean;
  onStart: () => void;
};

/**
 * Reduced composer shown on `/(app)/agent-chat/new` when a
 * `kilo remote` instance is selected. Per the C3b plan:
 * model / mode / repo / attachment affordances and the prompt box
 * are hidden; the "Run on" selector stays (so the user can switch
 * back to Cloud Agent or pick a different instance) and a single
 * "Start session" CTA drives the spawn.
 *
 * kilocode_change - the inline "disconnected" note lives in the FULL
 * (Cloud Agent) composer in `new.tsx`, not here: a retryable spawn
 * failure resets the selection to `null` in the SAME state update that
 * sets the note, which immediately swaps the screen away from this
 * component (`isRemoteTargetSelected` becomes `false`) — a note prop on
 * this component could never actually render.
 */
export function RemoteSpawnComposer({
  runOnInstance,
  instanceList,
  isLoadingInstances,
  onChangeRunOnInstance,
  isSpawningRemote,
  isStartDisabled,
  onStart,
}: Readonly<RemoteSpawnComposerProps>) {
  const colors = useThemeColors();
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View className="mt-2">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">Run on</Text>
        <InstanceSelector
          value={runOnInstance}
          instances={instanceList}
          isLoading={isLoadingInstances}
          onChange={onChangeRunOnInstance}
          disabled={isSpawningRemote}
        />
      </View>

      <Button size="lg" className="mt-6" disabled={isStartDisabled} onPress={onStart}>
        {isSpawningRemote ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Text>Start session</Text>
        )}
      </Button>
    </ScrollView>
  );
}
