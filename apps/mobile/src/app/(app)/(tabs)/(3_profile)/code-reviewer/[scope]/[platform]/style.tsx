import { type Href } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { REVIEW_STYLES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewerEditGuard,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useValidatedReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

const DESCRIPTIONS = {
  strict: 'Flag everything, hold a high bar',
  balanced: 'Meaningful findings without noise',
  lenient: 'Only serious problems',
  roast: 'Brutally honest, entertainingly so',
} as const;

export default function ReviewStyleRoute() {
  const params = useValidatedReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <ReviewStyleRouteContent scope={params.scope} platform={params.platform} />;
}

function ReviewStyleRouteContent({
  scope,
  platform,
}: Readonly<{
  scope: string;
  platform: ReviewerPlatform;
}>) {
  useReviewerEditGuard(scope, platform);
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

  return (
    <OptionList
      title="Review Style"
      options={REVIEW_STYLES}
      selected={data?.reviewStyle}
      descriptions={DESCRIPTIONS}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ reviewStyle: value })}
    />
  );
}
