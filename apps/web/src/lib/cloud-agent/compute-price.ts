export function formatComputePrice(hourlyUsd: number | null | undefined): string {
  if (hourlyUsd == null || !Number.isFinite(hourlyUsd) || hourlyUsd <= 0)
    return 'Price unavailable';
  if (hourlyUsd < 0.000001) return '<$0.000001/hour';
  return `${new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(hourlyUsd)}/hour`;
}
