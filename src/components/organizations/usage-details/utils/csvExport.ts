import type { TimePeriod } from '@/lib/organizations/organization-types';
import type { UsageDetailItem } from '../types';
import { formatIsoDateString_UsaDateOnlyFormat, formatLargeNumber } from '@/lib/utils';

/**
 * Exports usage details to a CSV file and triggers download.
 *
 * This utility creates a CSV file from raw usage data with proper escaping
 * and formatting. The CSV includes per-user, per-day (and optionally per-model)
 * usage details.
 *
 * @param usageDetails - Raw usage details from API
 * @param timePeriod - Time period for filename
 * @param groupByModel - Whether to include model column
 */
export function exportUsageToCSV(
  usageDetails: { daily?: UsageDetailItem[] } | undefined,
  timePeriod: TimePeriod,
  groupByModel: boolean
): void {
  if (!usageDetails?.daily || usageDetails.daily.length === 0) return;

  // Helper function to escape CSV values
  const escapeCsvValue = (value: string | number) => {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Create CSV headers based on grouping mode
  const headers = [
    'Date',
    'User Name',
    'User Email',
    ...(groupByModel ? ['Model'] : []),
    'Cost',
    'Requests',
    'Input Tokens',
    'Output Tokens',
    'Total Tokens',
  ];

  // Convert raw usage data to CSV rows - one row per user per day (per model if grouped)
  const csvRows = [
    headers.join(','), // Header row
    ...usageDetails.daily.map((usage: UsageDetailItem) => {
      const row = [
        escapeCsvValue(formatIsoDateString_UsaDateOnlyFormat(usage.date)),
        escapeCsvValue(usage.user.name || ''),
        escapeCsvValue(usage.user.email || ''),
        ...(groupByModel ? [escapeCsvValue(usage.model || 'Unknown')] : []),
        escapeCsvValue(`$${(parseFloat(usage.microdollarCost || '0') / 1000000).toFixed(6)}`),
        escapeCsvValue(formatLargeNumber(usage.requestCount)),
        escapeCsvValue(formatLargeNumber(usage.inputTokens)),
        escapeCsvValue(formatLargeNumber(usage.outputTokens)),
        escapeCsvValue(formatLargeNumber(usage.tokenCount)),
      ];
      return row.join(',');
    }),
  ];

  // Create and download the file
  const csvContent = csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute(
    'download',
    `usage-details-${timePeriod}${groupByModel ? '-by-model' : ''}-${new Date().toISOString().split('T')[0]}.csv`
  );
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
