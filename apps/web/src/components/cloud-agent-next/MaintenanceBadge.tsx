import { Pin, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function MaintenanceBadge({ pinned = false }: { pinned?: boolean }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 px-1.5 py-0 text-[10px] font-normal"
      title={
        pinned ? 'Automatically pinned while maintenance runs or needs your input.' : undefined
      }
    >
      {pinned ? (
        <Pin className="size-3" aria-label="Automatically pinned" />
      ) : (
        <Wrench className="size-3" aria-hidden="true" />
      )}
      Maintenance
    </Badge>
  );
}
