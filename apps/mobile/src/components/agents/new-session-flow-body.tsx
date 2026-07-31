import { type ComponentProps } from 'react';
import Animated, { FadeIn } from 'react-native-reanimated';
import { View } from 'react-native';

import { RunTargetStep } from '@/components/agents/run-target-step';
import { NewSessionCloudForm } from '@/components/agents/new-session-cloud-form';
import { RemoteSpawnComposer } from '@/components/agents/remote-spawn-composer';
import { Skeleton } from '@/components/ui/skeleton';
import { type NewSessionFlowMode } from '@/lib/new-session-flow-state';
import { isRepositorySectionVisible } from '@/lib/is-repository-section-visible';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

type NewSessionFlowBodyProps = {
  flowMode: NewSessionFlowMode;
  step: 1 | 2;
  // Step 1
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  initialPrompt: string;
  onSelectTarget: (instance: InstancePickerInstance | null) => void;
  // Cloud form
  cloudFormProps: ComponentProps<typeof NewSessionCloudForm>;
  // Remote composer
  remoteComposerProps: ComponentProps<typeof RemoteSpawnComposer>;
};

const SKELETON_BLOCK_COUNT = 3;

/**
 * Pure render switch for the new-session body. Receives all state as props
 * from the route; owns nothing. Each step body gets an entering FadeIn only.
 */
export function NewSessionFlowBody({
  flowMode,
  step,
  runOnInstance,
  instanceList,
  initialPrompt,
  onSelectTarget,
  cloudFormProps,
  remoteComposerProps,
}: Readonly<NewSessionFlowBodyProps>) {
  if (flowMode === 'pending') {
    return (
      <View className="flex-1 px-4 pt-4">
        {Array.from({ length: SKELETON_BLOCK_COUNT }, (_, i) => (
          <View key={i} className="mb-4">
            <Skeleton className="h-5 w-1/4 rounded-md" />
            <Skeleton className="mt-2 h-12 w-full rounded-lg" />
          </View>
        ))}
      </View>
    );
  }

  if (flowMode === 'single') {
    return isRepositorySectionVisible(runOnInstance) ? (
      <NewSessionCloudForm {...cloudFormProps} />
    ) : (
      <RemoteSpawnComposer {...remoteComposerProps} />
    );
  }

  if (step === 1) {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <RunTargetStep
          runOnInstance={runOnInstance}
          instanceList={instanceList}
          onSelectTarget={onSelectTarget}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      {runOnInstance ? (
        <RemoteSpawnComposer {...remoteComposerProps} showRunOnSelector={false} />
      ) : (
        <NewSessionCloudForm
          {...cloudFormProps}
          initialPrompt={initialPrompt}
          showRunOnSelector={false}
        />
      )}
    </Animated.View>
  );
}
