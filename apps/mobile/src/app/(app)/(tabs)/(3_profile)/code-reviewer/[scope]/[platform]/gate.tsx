import { type Href } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { GATE_THRESHOLDS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { useValidatedReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

const DESCRIPTIONS = {
  off: 'Never fail the PR check',
  all: 'Fail on any finding',
  warning: 'Fail on warnings and critical findings',
  critical: 'Fail on critical findings only',
} as const;

export default function GateThresholdRoute() {
  const params = useValidatedReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <GateThresholdRouteContent scope={params.scope} platform={params.platform} />;
}

function GateThresholdRouteContent({
  scope,
  platform,
}: Readonly<{
  scope: string;
  platform: ReviewerPlatform;
}>) {
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

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
