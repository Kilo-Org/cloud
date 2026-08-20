import { View } from 'react-native';

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
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">Council</Text>
      <View className="gap-1 rounded-lg bg-secondary p-4">
        <MetaRow label="Decision" value={councilDecisionLabel(councilResult.decision)} />
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
  statusLabel,
  gateThreshold,
}: Readonly<{ checkRunId: number | null; statusLabel: string; gateThreshold?: string }>) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">Gate</Text>
      <View className="gap-1 rounded-lg bg-secondary p-4">
        <MetaRow label="Check run" value={checkRunId != null ? `#${checkRunId}` : 'None'} />
        <MetaRow label="Status" value={statusLabel} />
        {gateThreshold ? <MetaRow label="Threshold" value={gateThreshold} /> : null}
      </View>
    </View>
  );
}
