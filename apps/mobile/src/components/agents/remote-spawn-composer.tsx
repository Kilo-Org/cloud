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
  /** When false, hides the Run-on selector and shows a muted target-context line instead. */
  showRunOnSelector?: boolean;
};

/**
 * Reduced composer shown on `/(app)/agent-chat/new` when a
 * `kilo remote` instance is selected. Per the C3b plan:
 * model / mode / repo / attachment affordances and the prompt box
 * are hidden; the "Run on" selector stays (so the user can switch
 * back to Cloud Agent or pick a different instance) and a single
 * "Start session" CTA drives the spawn.
 *
 * When `showRunOnSelector` is false (step 2 of the steps flow), the
 * selector is hidden and replaced by a muted target-context line. The
 * only affordance is the Start CTA — back to step 1 is the "switch
 * target" path.
 */
export function RemoteSpawnComposer({
  runOnInstance,
  instanceList,
  isLoadingInstances,
  onChangeRunOnInstance,
  isSpawningRemote,
  isStartDisabled,
  onStart,
  showRunOnSelector = true,
}: Readonly<RemoteSpawnComposerProps>) {
  const colors = useThemeColors();
  const targetLabel = runOnInstance ? `${runOnInstance.name} · ${runOnInstance.projectName}` : null;

  function renderRunTarget() {
    if (showRunOnSelector) {
      return (
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
      );
    }
    if (targetLabel) {
      return (
        <View className="mt-2">
          <Text className="text-sm text-muted-foreground">Run on: {targetLabel}</Text>
        </View>
      );
    }
    return null;
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="flex-grow px-4 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {renderRunTarget()}
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
