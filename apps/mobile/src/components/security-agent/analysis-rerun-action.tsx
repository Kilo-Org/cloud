import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { AnalysisCapacityNotice } from '@/components/security-agent/analysis-capacity-notice';
import { useSecurityAnalysisCapacity } from '@/lib/hooks/use-security-agent';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { getAnalysisCapacityBlockedHint } from '@/lib/security-agent-copy';

type AnalysisRerunActionProps = {
  scope: string;
  findingId: string;
};

/**
 * The action a stale analysis asks for. Both detail panels offer it where they
 * already explain the blocker — the remediation panel under the stale-analysis
 * copy, the analysis panel next to its own Analyze action — because the blocker
 * cannot be cleared from anywhere else in the app. Capacity is read here instead
 * of at each call site, so the button and its notice always agree.
 */
export function AnalysisRerunAction({ scope, findingId }: Readonly<AnalysisRerunActionProps>) {
  const { t } = useTranslation();
  const capacity = useSecurityAnalysisCapacity(scope);
  const startAnalysis = useStartSecurityAnalysis(scope);
  const hasCapacity = capacity.state === 'available';

  return (
    <View className="gap-2">
      <Button
        loading={startAnalysis.isPending}
        disabled={!hasCapacity}
        accessibilityHint={getAnalysisCapacityBlockedHint(capacity.state)}
        onPress={() => {
          startAnalysis.mutate({ findingId });
        }}
      >
        {t('securityAgent.analysis.rerunAnalysis')}
      </Button>
      <AnalysisCapacityNotice state={capacity.state} onRetry={() => void capacity.refetch()} />
    </View>
  );
}
