import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  councilDecisionLabel,
  councilVoteLabel,
} from '@/components/code-reviewer/review-detail-helpers';
import { Text } from '@/components/ui/text';
import { type useReviewDetail } from '@/lib/hooks/use-code-reviews';
import { cn } from '@/lib/utils';

// Derive the council/finding types from the review-detail tRPC result rather
// than re-declaring the db shape (mobile does not import @kilocode/db).
type ReviewDetailData = NonNullable<ReturnType<typeof useReviewDetail>['data']>;
type Review = Extract<ReviewDetailData, { success: true }>['review'];
type CouncilResult = NonNullable<Review['council_result']>;
type CouncilFinding = CouncilResult['specialists'][number]['findings'][number];

const SEVERITY_CLASS = {
  critical: 'text-destructive',
  warning: 'text-warn',
  suggestion: 'text-info',
  nitpick: 'text-muted-foreground',
} satisfies Record<string, string>;

export function MetaRow({
  label,
  value,
  valueClassName,
}: Readonly<{ label: string; value: string; valueClassName?: string }>) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text variant="muted" className="text-xs">
        {label}
      </Text>
      <Text className={cn('text-xs', valueClassName)}>{value}</Text>
    </View>
  );
}

export function FindingCard({ finding }: Readonly<{ finding: CouncilFinding }>) {
  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center justify-between">
        <Text
          className={cn(
            'text-xs font-medium',
            Object.hasOwn(SEVERITY_CLASS, finding.severity)
              ? SEVERITY_CLASS[finding.severity as keyof typeof SEVERITY_CLASS]
              : 'text-muted-foreground'
          )}
        >
          {finding.severity}
        </Text>
        <Text variant="muted" className="text-xs">
          {finding.path}
          {finding.line != null ? `:${finding.line}` : ''}
        </Text>
      </View>
      <Text className="text-xs">{finding.rationale}</Text>
    </View>
  );
}

export function CouncilSection({ councilResult }: Readonly<{ councilResult: CouncilResult }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">{t('codeReviewer.reviewDetail.council')}</Text>
      <View className="gap-1 rounded-lg bg-secondary p-4">
        <MetaRow
          label={t('codeReviewer.reviewDetail.decision')}
          value={councilDecisionLabel(councilResult.decision)}
        />
        {councilResult.specialists.map(specialist => (
          <MetaRow
            key={specialist.id}
            label={specialist.name}
            value={councilVoteLabel(specialist.vote)}
          />
        ))}
      </View>
    </View>
  );
}

export function GateSection({
  checkRunId,
  checkRunRedacted,
  statusLabel,
  gateThreshold,
}: Readonly<{
  checkRunId: number | null;
  checkRunRedacted?: boolean;
  statusLabel: string;
  gateThreshold?: string;
}>) {
  const { t } = useTranslation();
  let checkRunLabel = t('codeReviewer.reviewDetail.gateNone');
  if (checkRunId != null) {
    checkRunLabel = `#${checkRunId}`;
  } else if (checkRunRedacted) {
    checkRunLabel = t('codeReviewer.reviewDetail.gateHidden');
  }
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">{t('codeReviewer.reviewDetail.gate')}</Text>
      <View className="gap-1 rounded-lg bg-secondary p-4">
        <MetaRow label={t('codeReviewer.reviewDetail.checkRun')} value={checkRunLabel} />
        <MetaRow label={t('codeReviewer.reviewDetail.status')} value={statusLabel} />
        {gateThreshold ? (
          <MetaRow label={t('codeReviewer.reviewDetail.threshold')} value={gateThreshold} />
        ) : null}
      </View>
    </View>
  );
}
