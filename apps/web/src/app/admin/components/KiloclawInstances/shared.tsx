import { formatDistanceToNow } from 'date-fns';

export function parseTimestamp(timestamp: string): Date {
  const normalized = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasTimezone ? normalized : `${normalized}Z`);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return new Date(timestamp);
}

export function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return '—';
  return formatDistanceToNow(parseTimestamp(timestamp), { addSuffix: true });
}

export function formatAbsoluteTime(timestamp: string): string {
  return parseTimestamp(timestamp).toLocaleString('en-US');
}

export function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
