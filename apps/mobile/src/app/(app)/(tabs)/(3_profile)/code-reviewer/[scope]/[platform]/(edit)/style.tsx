import { useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { PUBLIC_REVIEW_STYLES } from '@kilocode/app-shared/code-review';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

const DESCRIPTIONS = {
  strict: 'Flag everything, hold a high bar',
  balanced: 'Meaningful findings without noise',
  lenient: 'Only serious problems',
} as const;

export default function ReviewStyleRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

  // A legacy 'roast' config has no matching public option; treat it as unselected.
  const selected = data?.reviewStyle === 'roast' ? undefined : data?.reviewStyle;

  return (
    <OptionList
      title="Review style"
      options={PUBLIC_REVIEW_STYLES}
      selected={selected}
      descriptions={DESCRIPTIONS}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ reviewStyle: value })}
    />
  );
}
