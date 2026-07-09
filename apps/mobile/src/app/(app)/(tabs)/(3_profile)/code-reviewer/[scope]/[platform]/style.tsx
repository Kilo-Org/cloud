import { useLocalSearchParams } from 'expo-router';

import { OptionList } from '@/components/code-reviewer/option-list';
import { asReviewerPlatform, REVIEW_STYLES } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

const DESCRIPTIONS = {
  strict: 'Flag everything, hold a high bar',
  balanced: 'Meaningful findings without noise',
  lenient: 'Only serious problems',
  roast: 'Brutally honest, entertainingly so',
} as const;

export default function ReviewStyleRoute() {
  const { scope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const platform = asReviewerPlatform(rawPlatform);
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
