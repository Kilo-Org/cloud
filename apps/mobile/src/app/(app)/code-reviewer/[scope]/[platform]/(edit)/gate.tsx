import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { OptionList } from '@/components/code-reviewer/option-list';
import { GATE_THRESHOLDS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

export default function GateThresholdRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <GateThresholdScreen scope={params.scope} platform={params.platform} />;
}

function GateThresholdScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();
  const labels = {
    off: t('common.off'),
    all: t('common.all'),
    warning: t('codeReviewer.gateThreshold.warning'),
    critical: t('common.critical'),
  } as const;
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
      labels={labels}
      descriptions={descriptions}
      disabled={data == null}
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onSelect={value => save.mutateAsync({ gateThreshold: value })}
    />
  );
}
