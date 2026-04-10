import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  trialing: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  past_due: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  unpaid: 'bg-red-500/10 text-red-300 border-red-500/20',
  paused: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  suspended: 'bg-red-500/10 text-red-300 border-red-500/20',
  pending_cancellation: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  canceled: 'bg-muted text-muted-foreground border-border',
  cancelled: 'bg-muted text-muted-foreground border-border',
  ended: 'bg-muted text-muted-foreground border-border',
  incomplete_expired: 'bg-muted text-muted-foreground border-border',
  incomplete: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
};

function formatStatusLabel(status: string): string {
  if (status === 'pending_cancellation') return 'Cancellation Scheduled';
  return status.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function SubscriptionStatusBadge({
  status,
  variant = 'default',
}: {
  status: string;
  variant?: 'default' | 'muted';
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-medium',
        statusStyles[status] ?? 'bg-secondary text-secondary-foreground border-transparent',
        variant === 'muted' && 'opacity-70'
      )}
    >
      {formatStatusLabel(status)}
    </Badge>
  );
}
