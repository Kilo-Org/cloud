import { formatDistanceToNow } from 'date-fns';

const KILOCLAW_EVENT_ATTRIBUTION_EVENTS = new Set([
  'instance.started',
  'instance.stopped',
  'instance.destroy_started',
  'instance.async_start_requested',
  'instance.manual_start_succeeded',
  'instance.manual_start_failed',
  'instance.async_start_request_failed',
]);

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

export function getKiloclawEventAttribution(
  event: string,
  label: string | null | undefined
): string | null {
  if (!label) {
    return null;
  }

  return KILOCLAW_EVENT_ATTRIBUTION_EVENTS.has(event) ? label : null;
}

export function EventLabelCell({
  event,
  label,
}: {
  event: string;
  label: string | null | undefined;
}) {
  const attribution = getKiloclawEventAttribution(event, label);

  if (!label) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  if (!attribution) {
    return <span className="text-xs">{label}</span>;
  }

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">Attribution</div>
      <code className="text-xs">{attribution}</code>
    </div>
  );
}

export function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
