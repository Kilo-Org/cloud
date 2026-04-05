import { Badge } from '@/components/ui/badge';

export function BotRequestStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed' ? 'default' : status === 'error' ? 'destructive' : 'secondary';

  return <Badge variant={variant}>{status}</Badge>;
}
