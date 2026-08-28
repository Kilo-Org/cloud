import type { DataExportHealth } from './data-export-types';

export { formatTimestamp, formatAge, humanizeToken } from '@/lib/admin/queue-format';

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Not available';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

type Severity = DataExportHealth['severity'];

export function severityLabel(severity: Severity): string {
  if (severity === 'error') return 'Error';
  if (severity === 'degraded') return 'Degraded';
  return 'OK';
}

export function severityBadgeClass(severity: Severity): string {
  if (severity === 'error')
    return 'border-status-destructive-border bg-status-destructive-surface text-status-destructive';
  if (severity === 'degraded')
    return 'border-status-warning-border bg-status-warning-surface text-status-warning';
  return 'border-status-success-border bg-status-success-surface text-status-success';
}

export function statusBadgeClass(status: string): string {
  if (status === 'failed')
    return 'border-status-destructive-border bg-status-destructive-surface text-status-destructive';
  if (status === 'ready')
    return 'border-status-success-border bg-status-success-surface text-status-success';
  if (status === 'expired') return 'border-border bg-secondary text-secondary-foreground';
  return 'border-status-info-border bg-status-info-surface text-status-info';
}

export function emailStatusBadgeClass(status: string): string {
  if (status === 'failed')
    return 'border-status-destructive-border bg-status-destructive-surface text-status-destructive';
  if (status === 'sent')
    return 'border-status-success-border bg-status-success-surface text-status-success';
  if (status === 'sending')
    return 'border-status-info-border bg-status-info-surface text-status-info';
  return 'border-border bg-secondary text-secondary-foreground';
}

export function booleanBadgeClass(value: boolean): string {
  return value
    ? 'border-status-success-border bg-status-success-surface text-status-success'
    : 'border-border bg-secondary text-secondary-foreground';
}
