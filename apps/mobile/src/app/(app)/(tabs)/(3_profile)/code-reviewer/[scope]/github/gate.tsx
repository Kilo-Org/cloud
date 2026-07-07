import { useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { GATE_THRESHOLDS } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

const DESCRIPTIONS = {
  off: 'Never fail the PR check',
  all: 'Fail on any finding',
  warning: 'Fail on warnings and critical findings',
  critical: 'Fail on critical findings only',
} as const;

export default function GateThresholdRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  const { data } = useReviewConfig(scope, 'github');
  const save = useSaveReviewConfig(scope, 'github');

  return (
    <OptionList
      title="Merge Gate"
      options={GATE_THRESHOLDS}
      selected={data?.gateThreshold}
      descriptions={DESCRIPTIONS}
      onSelect={value => {
        save.mutate({ gateThreshold: value });
      }}
    />
  );
}
