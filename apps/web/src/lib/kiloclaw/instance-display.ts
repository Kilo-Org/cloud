export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatPercent(rawPercent: number): string {
  return rawPercent % 1 === 0
    ? rawPercent.toFixed(0)
    : (Math.round(rawPercent * 10) / 10).toFixed(1);
}

export function formatVolumeUsage(
  used: number | null | undefined,
  total: number | null | undefined,
  style: 'of' | 'used-total' = 'of'
): string {
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    used < 0 ||
    total <= 0
  ) {
    return '—';
  }

  const pct = formatPercent((used / total) * 100);
  if (style === 'used-total') {
    return `${formatBytes(used)} used / ${formatBytes(total)} total (${pct}%)`;
  }

  return `${formatBytes(used)} of ${formatBytes(total)} (${pct}%)`;
}

export function getVolumeUsagePercent(
  used: number | null | undefined,
  total: number | null | undefined
): number | null {
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }

  return Math.max(0, Math.min(100, (used / total) * 100));
}

export function getVolumeBarColor(percent: number | null): string {
  if (percent === null) return 'bg-emerald-500';
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 75) return 'bg-amber-500';
  return 'bg-emerald-500';
}
