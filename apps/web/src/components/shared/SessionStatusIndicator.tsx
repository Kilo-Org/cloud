import { StatusSpinner } from './StatusSpinner';

const VISIBLE_STATUSES = new Set(['busy', 'question', 'permission', 'retry']);

export type SessionActivityIndicatorKind = 'working' | 'attention';

export function shouldShowSessionStatus(status: string | null, _statusUpdatedAt: string | null) {
  if (!status || !VISIBLE_STATUSES.has(status)) return false;
  return true;
}

export function getSessionActivityIndicatorKind(
  status: string | null,
  statusUpdatedAt: string | null
): SessionActivityIndicatorKind | null {
  if (!shouldShowSessionStatus(status, statusUpdatedAt)) return null;

  if (status === 'busy' || status === 'retry') return 'working';
  if (status === 'question' || status === 'permission') return 'attention';

  return null;
}

export function SessionStatusIndicator({
  status,
  statusUpdatedAt,
}: {
  status: string | null;
  statusUpdatedAt: string | null;
}) {
  const indicatorKind = getSessionActivityIndicatorKind(status, statusUpdatedAt);
  if (!indicatorKind || !status) return null;

  switch (indicatorKind) {
    case 'working':
      return (
        <StatusSpinner
          className="h-4 w-4 shrink-0 text-gray-600"
          title={status === 'retry' ? 'Retrying' : 'Busy'}
        />
      );
    case 'attention':
      return <NeedsAttentionIndicator title={getNeedsAttentionTitle(status)} />;
  }
}

function NeedsAttentionIndicator({ title }: { title: string }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0" title={title} aria-label={title}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  );
}

function getNeedsAttentionTitle(status: string) {
  switch (status) {
    case 'question':
      return 'Waiting for answer';
    case 'permission':
      return 'Waiting for permission';
    default:
      return 'Needs attention';
  }
}
