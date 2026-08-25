import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { OptionList } from '@/components/code-reviewer/option-list';
import { GATE_THRESHOLDS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

export default function GateThresholdRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();
  const descriptions = {
    off: t('codeReviewer.gate.off'),
    all: t('codeReviewer.gate.all'),
    warning: t('codeReviewer.gate.warning'),
    critical: t('codeReviewer.gate.critical'),
  } as const;

  return (
    <OptionList
      title={t('codeReviewer.gate.title')}
      options={GATE_THRESHOLDS}
      selected={data?.gateThreshold}
      descriptions={descriptions}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ gateThreshold: value })}
    />
  );
}
