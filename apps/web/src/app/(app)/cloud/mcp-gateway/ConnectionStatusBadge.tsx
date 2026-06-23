import { cn } from '@/lib/utils';

type ConnectionStatusInput = {
  enabled: boolean;
  authMode: string;
  activeGrantCount: number;
  assignmentCount: number;
};

type StatusTone = 'positive' | 'attention' | 'neutral';

type ConnectionStatus = {
  label: string;
  description: string;
  tone: StatusTone;
};

export function getConnectionStatus(connection: ConnectionStatusInput): ConnectionStatus {
  if (!connection.enabled) {
    return { label: 'Disabled', description: 'Requests are blocked', tone: 'neutral' };
  }
  if (connection.authMode === 'none' || connection.authMode === 'static_headers') {
    return { label: 'Ready', description: 'No provider sign-in required', tone: 'positive' };
  }
  if (connection.activeGrantCount > 0) {
    if (connection.assignmentCount > connection.activeGrantCount) {
      return {
        label: 'Partially signed in',
        description: `${connection.activeGrantCount} of ${connection.assignmentCount} assigned users have active grants`,
        tone: 'attention',
      };
    }
    return {
      label: 'Signed in',
      description:
        connection.assignmentCount > 0
          ? `${connection.activeGrantCount} assigned users have active grants`
          : 'A user has an active grant',
      tone: 'positive',
    };
  }
  return { label: 'Needs sign-in', description: 'No active provider grant yet', tone: 'attention' };
}

const toneDot: Record<StatusTone, string> = {
  positive: 'bg-green-400',
  attention: 'bg-yellow-400',
  neutral: 'bg-muted-foreground',
};

const toneClassName: Record<StatusTone, string> = {
  positive: 'bg-green-500/20 text-green-400 ring-green-500/20',
  attention: 'bg-yellow-500/20 text-yellow-400 ring-yellow-500/20',
  neutral: 'bg-secondary text-muted-foreground ring-border',
};

export function ConnectionStatusBadge({
  connection,
  className,
}: {
  connection: ConnectionStatusInput;
  className?: string;
}) {
  const status = getConnectionStatus(connection);
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium ring-1',
        toneClassName[status.tone],
        className
      )}
      aria-label={`${status.label}: ${status.description}`}
      title={status.description}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', toneDot[status.tone])} />
      {status.label}
    </span>
  );
}
