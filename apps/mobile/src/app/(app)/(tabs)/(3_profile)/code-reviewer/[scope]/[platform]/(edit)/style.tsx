import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { OptionList } from '@/components/code-reviewer/option-list';
import { REVIEW_STYLES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

export default function ReviewStyleRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();
  const labels = {
    strict: t('codeReviewer.reviewStyle.strict'),
    balanced: t(
      // i18n-dup-ok: 'common.balanced' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
      'common.balanced'
    ),
    lenient: t('codeReviewer.reviewStyle.lenient'),
    roast: t('codeReviewer.reviewStyle.roast'),
  } as const;
  const descriptions = {
    strict: t('codeReviewer.style.strict'),
    balanced: t('codeReviewer.style.balanced'),
    lenient: t('codeReviewer.style.lenient'),
    roast: t('codeReviewer.style.roast'),
  } as const;

  return (
    <OptionList
      title={t('codeReviewer.style.title')}
      options={REVIEW_STYLES}
      selected={data?.reviewStyle}
      labels={labels}
      descriptions={descriptions}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ reviewStyle: value })}
    />
  );
}
