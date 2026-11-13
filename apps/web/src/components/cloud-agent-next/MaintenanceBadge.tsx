import { Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function MaintenanceBadge({ pinned = false }: { pinned?: boolean }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-violet-400/20 px-1 py-0 text-[10px] font-normal text-violet-400"
      title={pinned ? 'Pinned while auto-fix runs or needs your input.' : undefined}
    >
      <Zap className="size-3" aria-hidden="true" />
      Auto fix
    </Badge>
  );
}
