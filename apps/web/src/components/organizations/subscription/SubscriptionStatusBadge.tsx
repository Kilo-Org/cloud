import { Badge } from '@/components/ui/badge';
import { getSubscriptionStatusConfig } from './subscriptionStatusConfig';

export function SubscriptionStatusBadge({ status }: { status: string }) {
  const config = getSubscriptionStatusConfig(status);
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className="flex items-center gap-1">
      <Icon className={`h-3 w-3 ${config.color}`} />
      {status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}
    </Badge>
  );
}
