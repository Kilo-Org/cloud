import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { OptionList } from '@/components/code-reviewer/option-list';
import { ReviewerErrorScreen } from '@/components/code-reviewer/reviewer-error-screen';
import { REVIEW_STYLES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { reviewConfigFailure, useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

export default function ReviewStyleRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <ReviewStyleScreen scope={params.scope} platform={params.platform} />;
}

function ReviewStyleScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const config = useReviewConfig(scope, platform);
  const configBody = useReviewConfigBody(config);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();
  const title = t('codeReviewer.style.title');
  const failure = reviewConfigFailure(configBody, config.isFetching);
  const labels = {
    strict: t('codeReviewer.reviewStyle.strict'),
    balanced: t('common.balanced'),
    lenient: t('codeReviewer.reviewStyle.lenient'),
    roast: t('codeReviewer.reviewStyle.roast'),
  } as const;
  const descriptions = {
    strict: t('codeReviewer.style.strict'),
    balanced: t('codeReviewer.style.balanced'),
    lenient: t('codeReviewer.style.lenient'),
    roast: t('codeReviewer.style.roast'),
  } as const;

  if (failure) {
    // A config read that failed, or one that stayed pending with nothing in
    // flight even after its automatic restart, would otherwise leave every
    // row disabled with no explanation and no action that resolves it.
    return (
      <ReviewerErrorScreen
        title={title}
        variant={failure.variant}
        onRetry={() => {
          failure.onRetry();
        }}
        isRetrying={failure.isRetrying}
      />
    );
  }

  return (
    <OptionList
      title={title}
      options={REVIEW_STYLES}
      selected={config.data?.reviewStyle}
      labels={labels}
      descriptions={descriptions}
      disabled={configBody.body.status !== 'ready'}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ reviewStyle: value })}
    />
  );
}
