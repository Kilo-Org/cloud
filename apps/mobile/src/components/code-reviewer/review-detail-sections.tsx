import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  councilDecisionLabel,
  councilVoteLabel,
  gateThresholdLabel,
  severityLabelKey,
} from '@/components/code-reviewer/review-detail-helpers';
import { Card } from '@/components/ui/card';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
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

export function FindingCard({ finding }: Readonly<{ finding: CouncilFinding }>) {
  const { t } = useTranslation();
  return (
    <Card className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text
          className={cn(
            'text-xs font-medium',
            Object.hasOwn(SEVERITY_CLASS, finding.severity)
              ? SEVERITY_CLASS[finding.severity as keyof typeof SEVERITY_CLASS]
              : 'text-muted-foreground'
          )}
        >
          {t(severityLabelKey(finding.severity))}
        </Text>
        <Text variant="muted" className="text-xs">
          {finding.path}
          {finding.line != null ? `:${finding.line}` : ''}
        </Text>
      </View>
      <Text className="text-xs">{finding.rationale}</Text>
    </Card>
  );
}

export function CouncilSection({ councilResult }: Readonly<{ councilResult: CouncilResult }>) {
  const { t } = useTranslation();
  return (
    <Section label={t('codeReviewer.reviewDetail.council')}>
      {/* Facts, not a card of prose: every key/value row on this screen is the
          shared row, so the council's rows stand at the same height as the
          gate's and the details'. */}
      <RowGroup>
        <KvRow
          label={t('codeReviewer.reviewDetail.decision')}
          value={councilDecisionLabel(councilResult.decision)}
          valueFace="text"
        />
        {councilResult.specialists.map(specialist => (
          <KvRow
            key={specialist.id}
            label={specialist.name}
            value={councilVoteLabel(specialist.vote)}
            valueFace="text"
          />
        ))}
      </RowGroup>
    </Section>
  );
}

export function GateSection({
  checkRunId,
  checkRunRedacted,
  gateThreshold,
}: Readonly<{
  checkRunId: number | null;
  checkRunRedacted?: boolean;
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
    <Section label={t('codeReviewer.reviewDetail.gate')}>
      <RowGroup>
        <KvRow
          label={t('codeReviewer.reviewDetail.checkRun')}
          value={checkRunLabel}
          valueFace={checkRunId == null ? 'text' : 'mono'}
        />
        {gateThreshold ? (
          <KvRow
            label={t('codeReviewer.reviewDetail.threshold')}
            value={gateThresholdLabel(gateThreshold)}
            valueFace="text"
          />
        ) : null}
      </RowGroup>
    </Section>
  );
}
