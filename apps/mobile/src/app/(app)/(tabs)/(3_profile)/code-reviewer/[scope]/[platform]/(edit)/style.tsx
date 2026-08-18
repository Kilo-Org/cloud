import { useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { REVIEW_STYLES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

const DESCRIPTIONS = {
  strict: 'Flag everything, hold a high bar',
  balanced: 'Meaningful findings without noise',
  lenient: 'Only serious problems',
  roast: 'Brutally honest, entertainingly so',
} as const;

export default function ReviewStyleRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

  return (
    <OptionList
      title="Review style"
      options={REVIEW_STYLES}
      selected={data?.reviewStyle}
      descriptions={DESCRIPTIONS}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ reviewStyle: value })}
    />
  );
}
