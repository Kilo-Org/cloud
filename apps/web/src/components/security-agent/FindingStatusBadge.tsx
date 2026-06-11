import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function FindingStatusBadge({ status }: { status: string }) {
  if (status === 'open') {
    return (
      <Badge className="gap-1 border-0 bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400 ring-1 ring-yellow-500/20">
        <AlertTriangle className="size-3" aria-hidden="true" />
        Open
      </Badge>
    );
  }
  if (status === 'fixed') {
    return (
      <Badge className="gap-1 border-0 bg-green-500/20 px-2 py-0.5 text-xs text-green-400 ring-1 ring-green-500/20">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        Fixed
      </Badge>
    );
  }
  if (status === 'ignored') {
    return (
      <Badge className="text-muted-foreground gap-1 border-0 bg-zinc-500/20 px-2 py-0.5 text-xs ring-1 ring-zinc-500/20">
        <XCircle className="size-3" aria-hidden="true" />
        Dismissed
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}
