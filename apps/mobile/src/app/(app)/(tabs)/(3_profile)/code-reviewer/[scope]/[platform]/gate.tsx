import { type Href, useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { InvalidRouteState } from '@/components/invalid-route-state';
import {
  GATE_THRESHOLDS,
  parseReviewerPlatform,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { parseParam } from '@/lib/route-params';

const DESCRIPTIONS = {
  off: 'Never fail the PR check',
  all: 'Fail on any finding',
  warning: 'Fail on warnings and critical findings',
  critical: 'Fail on critical findings only',
} as const;

export default function GateThresholdRoute() {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  const platform = scope ? parseReviewerPlatform(scope, rawPlatform) : null;

  if (!scope || !platform) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <GateThresholdRouteContent scope={scope} platform={platform} />;
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
