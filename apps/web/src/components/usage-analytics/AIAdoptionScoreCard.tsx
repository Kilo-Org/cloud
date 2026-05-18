'use client';
import { AIAdoptionChart } from '@/components/organizations/usage-details/components/AIAdoptionChart';
import { useOrganizationAIAdoptionTimeseries } from '@/app/api/organizations/hooks';
import type { DateRange } from './hooks';

type AIAdoptionScoreCardProps = {
  organizationId: string;
  dateRange: DateRange;
};

/**
 * Thin adapter that feeds the new dashboard's date range into the
 * existing `AIAdoptionChart`. Rendered only for organization context.
 */
export function AIAdoptionScoreCard({ organizationId, dateRange }: AIAdoptionScoreCardProps) {
  const adoption = useOrganizationAIAdoptionTimeseries(
    organizationId,
    dateRange.startDate,
    dateRange.endDate
  );
  return <AIAdoptionChart adoption={adoption} organizationId={organizationId} />;
}
