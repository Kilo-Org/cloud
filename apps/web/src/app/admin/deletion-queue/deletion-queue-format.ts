export function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function formatAge(fromIso: string, asOfIso: string): string {
  const from = new Date(fromIso).getTime();
  const asOf = new Date(asOfIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(asOf)) return '—';
  const diffSeconds = Math.max(0, Math.round((asOf - from) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function humanizeToken(value: string): string {
  return value.replaceAll(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
}

const STEP_LABELS: Record<string, { label: string; description: string }> = {
  kiloclaw_destroy: {
    label: 'KiloClaw',
    description: 'Destroy instances owned by this user',
  },
  customerio: {
    label: 'Customer.io',
    description: 'Remove the person from messaging',
  },
  cli_v1_blobs: {
    label: 'CLI v1',
    description: 'Delete leftover CLI v1 session blobs',
  },
  cli_v2_sessions: {
    label: 'CLI sessions',
    description: 'Delete CLI v2 sessions via ingest',
  },
  usage_prompt_prefixes: {
    label: 'Usage prompts',
    description: 'Scrub user and system prompt prefixes from usage metadata',
  },
  posthog: {
    label: 'PostHog',
    description: 'Delete the person and related events',
  },
  substack: {
    label: 'Substack',
    description: 'Remove the exact-match subscriber',
  },
  anonymize: {
    label: 'Cloud user',
    description: 'Anonymize the Cloud account',
  },
  pylon_reply: {
    label: 'Pylon reply',
    description: 'Post the deletion reply on the ticket',
  },
  pylon_contact: {
    label: 'Pylon delete',
    description: 'Delete the Pylon contact',
  },
};

export function deletionStepLabel(stepKey: string): string {
  return STEP_LABELS[stepKey]?.label ?? humanizeToken(stepKey);
}

export function deletionStepDescription(stepKey: string): string {
  return STEP_LABELS[stepKey]?.description ?? '';
}

export function deletionStepCountLabel(stepKey: string, count: number): string {
  switch (stepKey) {
    case 'usage_prompt_prefixes':
      return `${count} scrubbed`;
    case 'kiloclaw_destroy':
      return `${count} destroyed`;
    case 'customerio':
    case 'substack':
      return `${count} removed`;
    default:
      return `${count} deleted`;
  }
}

export function deletionStepProgressLabel(
  stepKey: string,
  processedCount: number,
  scannedCount = 0
): string | null {
  const parts: string[] = [];
  if (processedCount > 0) parts.push(deletionStepCountLabel(stepKey, processedCount));
  if (scannedCount > 0) parts.push(`${scannedCount} scanned`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatActivityDetail(item: {
  stepKey: string | null;
  details: {
    processedCount: number | null;
    scannedCount?: number | null;
    errorCode: string | null;
    httpStatusClass?: string | null;
  };
}): string {
  const count =
    item.stepKey && item.details.processedCount != null
      ? deletionStepCountLabel(item.stepKey, item.details.processedCount)
      : null;
  const scanned = item.details.scannedCount != null ? `${item.details.scannedCount} scanned` : null;
  return (
    [
      item.stepKey ? deletionStepLabel(item.stepKey) : null,
      count,
      scanned,
      item.details.errorCode,
      item.details.httpStatusClass,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function statusBadgeClass(status: string): string {
  if (status === 'needs_attention' || status === 'cancelled') {
    return 'border-status-destructive-border bg-status-destructive-surface text-status-destructive';
  }
  if (status === 'manual_action_required' || status === 'retry_wait') {
    return 'border-status-warning-border bg-status-warning-surface text-status-warning';
  }
  if (
    status === 'completed' ||
    status === 'succeeded' ||
    status === 'not_applicable' ||
    status === 'manually_verified'
  ) {
    return 'border-status-success-border bg-status-success-surface text-status-success';
  }
  if (status === 'in_progress' || status === 'running' || status === 'finalizing') {
    return 'border-status-info-border bg-status-info-surface text-status-info';
  }
  return 'border-border bg-secondary text-secondary-foreground';
}

export type DeletionQueueTab =
  | 'open'
  | 'needs_attention'
  | 'rate_limited'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export const DELETION_QUEUE_TABS: Array<{ value: DeletionQueueTab; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'rate_limited', label: 'Rate limited' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function parseDeletionQueueTab(value: string | null): DeletionQueueTab {
  if (value === 'manual_action') return 'needs_attention';
  return DELETION_QUEUE_TABS.some(tab => tab.value === value)
    ? (value as DeletionQueueTab)
    : 'open';
}

const EMAIL_EXTRACT = /[^\s@,;()<>"[\]{}]+@[^\s@,;()<>"[\]{}]+\.[A-Za-z]{2,}/g;
const PYLON_URL =
  /(?:https?:\/\/app\.usepylon\.com[^\s]*\/issues\/|issues\/)(iss_[a-zA-Z0-9]+|\d+)/i;
const PYLON_TICKET = /(?:^|[\s#(,])(\d{1,8}|iss_[a-zA-Z0-9]+)(?:[\s),;]|$)/i;

export function parseDeletionEntries(text: string): Array<{ email: string; pylonTicket?: string }> {
  const segments = text
    .split(/\r?\n/)
    .flatMap(line => line.split(/[,;]+/))
    .map(segment => segment.trim())
    .filter(Boolean);

  const entries: Array<{ email: string; pylonTicket?: string }> = [];
  for (const segment of segments) {
    const emailMatches = segment.match(EMAIL_EXTRACT) ?? [];
    const urlMatch = segment.match(PYLON_URL);
    const ticket = urlMatch?.[1]?.trim() || segment.match(PYLON_TICKET)?.[1]?.trim();
    if (emailMatches.length > 1) continue;
    const email = emailMatches[0]?.trim() ?? '';
    const leftover = leftoverAfterExtract(segment, email, ticket, urlMatch?.[0]);
    if (!email && leftover) {
      entries.push(ticket ? { email: leftover, pylonTicket: ticket } : { email: leftover });
      continue;
    }
    if (!email && !ticket) continue;
    if (!email) {
      entries.push({ email: '', pylonTicket: ticket });
      continue;
    }
    entries.push(ticket ? { email, pylonTicket: ticket } : { email });
  }
  return entries;
}

function leftoverAfterExtract(
  segment: string,
  email: string,
  ticket: string | undefined,
  urlMatch: string | undefined
): string {
  let rest = segment;
  if (email) rest = rest.split(email).join(' ');
  if (urlMatch) rest = rest.split(urlMatch).join(' ');
  if (ticket) {
    rest = rest.split(`#${ticket}`).join(' ');
    rest = rest.split(ticket).join(' ');
  }
  return rest.replace(/[\s,;()]+/g, ' ').trim();
}
