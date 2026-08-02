import { type ComponentProps } from 'react';
import Animated, { FadeIn } from 'react-native-reanimated';
import { View } from 'react-native';

import { RunTargetStep } from '@/components/agents/run-target-step';
import { NewSessionConfigureForm } from '@/components/agents/new-session-configure-form';
import { Skeleton } from '@/components/ui/skeleton';
import { type NewSessionFlowMode } from '@/lib/new-session-flow-state';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

type NewSessionFlowBodyProps = {
  flowMode: NewSessionFlowMode;
  step: 1 | 2;
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  initialPrompt: string;
  onSelectTarget: (instance: InstancePickerInstance | null) => void;
  configureProps: ComponentProps<typeof NewSessionConfigureForm>;
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
  configureProps,
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
    return <NewSessionConfigureForm {...configureProps} />;
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
      <NewSessionConfigureForm
        {...configureProps}
        initialPrompt={initialPrompt}
        showRunOnSelector={false}
      />
    </Animated.View>
  );
}
