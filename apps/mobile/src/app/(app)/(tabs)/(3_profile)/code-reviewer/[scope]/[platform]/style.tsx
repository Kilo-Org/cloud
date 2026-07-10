import { type Href, useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { InvalidRouteState } from '@/components/invalid-route-state';
import {
  parseReviewerPlatform,
  REVIEW_STYLES,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { parseParam } from '@/lib/route-params';

const DESCRIPTIONS = {
  strict: 'Flag everything, hold a high bar',
  balanced: 'Meaningful findings without noise',
  lenient: 'Only serious problems',
  roast: 'Brutally honest, entertainingly so',
} as const;

export default function ReviewStyleRoute() {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  const platform = scope ? parseReviewerPlatform(scope, rawPlatform) : null;

  if (!scope || !platform) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <ReviewStyleRouteContent scope={scope} platform={platform} />;
}

function ReviewStyleRouteContent({
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
      title="Review Style"
      options={REVIEW_STYLES}
      selected={data?.reviewStyle}
      descriptions={DESCRIPTIONS}
      onSelect={value => {
        save.mutate({ reviewStyle: value });
      }}
    />
  );
}
