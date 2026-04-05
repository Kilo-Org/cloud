'use client';

import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

export function FindingStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'open':
      return (
        <Badge
          variant="outline"
          className="border-yellow-500/30 bg-yellow-500/20 px-2 py-0.5 text-sm text-yellow-400"
        >
          <AlertTriangle className="mr-1 h-3 w-3" />
          Open
        </Badge>
      );
    case 'fixed':
      return (
        <Badge
          variant="outline"
          className="border-green-500/30 bg-green-500/20 px-2 py-0.5 text-sm text-green-400"
        >
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Fixed
        </Badge>
      );
    case 'ignored':
      return (
        <Badge
          variant="outline"
          className="text-muted-foreground border-gray-500/30 bg-gray-500/20 px-2 py-0.5 text-sm"
        >
          <XCircle className="mr-1 h-3 w-3" />
          Ignored
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
