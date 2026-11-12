export function formatComputePrice(hourlyUsd: number | null | undefined): string {
  if (hourlyUsd == null || !Number.isFinite(hourlyUsd) || hourlyUsd <= 0)
    return 'Price unavailable';
  if (hourlyUsd < 0.01) return '<$0.01/hr';
  return `~${formatHourlyRate(hourlyUsd)}`;
}

export function formatHourlyRate(hourlyUsd: number): string {
  return `${new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hourlyUsd)}/hr`;
}
