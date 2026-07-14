import { useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { GATE_THRESHOLDS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

const DESCRIPTIONS = {
  off: 'Never fail the PR check',
  all: 'Fail on any finding',
  warning: 'Fail on warnings and critical findings',
  critical: 'Fail on critical findings only',
} as const;

export default function GateThresholdRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

  return (
    <OptionList
      title="Merge gate"
      options={GATE_THRESHOLDS}
      selected={data?.gateThreshold}
      descriptions={DESCRIPTIONS}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ gateThreshold: value })}
    />
  );
}
