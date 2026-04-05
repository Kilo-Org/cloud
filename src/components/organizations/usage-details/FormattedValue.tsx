import React from 'react';
import { FormattedMicrodollars } from '@/components/organizations/FormattedMicrodollars';
import { formatLargeNumber } from '@/lib/utils';

export type OrganizationUsageMetric =
  | 'cost'
  | 'requests'
  | 'avg_cost_per_req'
  | 'tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'active_users';

export type ActiveFilter = {
  type: 'include' | 'exclude';
  subType: 'user' | 'project' | 'model';
  value: string;
};

export type FilterCardItem = {
  label: string;
  value: number;
  percentage: number;
};

export const isItemFiltered = (
  itemLabel: string,
  filterType: 'include' | 'exclude',
  activeFilters: ActiveFilter[]
) => {
  return activeFilters.some(filter => filter.value === itemLabel && filter.type === filterType);
};

export type FormattedValueProps = {
  value: number;
  metric: OrganizationUsageMetric;
};

export function FormattedValue({ value, metric }: FormattedValueProps) {
  switch (metric) {
    case 'cost':
    case 'avg_cost_per_req':
      return (
        <FormattedMicrodollars microdollars={value} decimalPlaces={value / 1_000_000 > 1 ? 2 : 4} />
      );
    case 'requests':
    case 'tokens':
    case 'input_tokens':
    case 'output_tokens':
      return <>{formatLargeNumber(value)}</>;
    case 'active_users':
      return <>{Math.round(value).toString()}</>;
    default:
      return <>{value.toString()}</>;
  }
}

export const getProgressColor = (_percentage: number) => {
  // Use consistent blue color for all progress bars
  return 'bg-blue-400';
};
