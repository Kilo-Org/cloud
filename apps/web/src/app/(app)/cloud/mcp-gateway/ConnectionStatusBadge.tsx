import { cn } from '@/lib/utils';

type ConnectionStatusInput = {
  enabled: boolean;
  authMode: string;
  activeGrantCount: number;
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
    return { label: 'Signed in', description: 'A user has an active grant', tone: 'positive' };
  }
  return { label: 'Needs sign-in', description: 'No active provider grant yet', tone: 'attention' };
}

const toneDot: Record<StatusTone, string> = {
  positive: 'bg-green-400',
  attention: 'bg-amber-400',
  neutral: 'bg-muted-foreground',
};

const toneText: Record<StatusTone, string> = {
  positive: 'text-foreground',
  attention: 'text-amber-200',
  neutral: 'text-muted-foreground',
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
      className={cn('inline-flex items-center gap-2 text-sm', toneText[status.tone], className)}
      title={status.description}
    >
      <span aria-hidden className={cn('size-2 rounded-full', toneDot[status.tone])} />
      {status.label}
    </span>
  );
}
