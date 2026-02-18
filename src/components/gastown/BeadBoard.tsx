'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type Bead = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string | null;
  assignee_agent_id: string | null;
  priority: string;
  labels: string[];
  created_at: string;
  closed_at: string | null;
};

type BeadBoardProps = {
  beads: Bead[];
  isLoading: boolean;
  onDeleteBead?: (beadId: string) => void;
};

const statusColumns = ['open', 'in_progress', 'closed'] as const;

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  closed: 'Closed',
};

const statusColors: Record<string, string> = {
  open: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  closed: 'bg-green-500/10 text-green-400 border-green-500/20',
};

const priorityColors: Record<string, string> = {
  low: 'text-gray-400',
  medium: 'text-blue-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
};

function BeadCard({ bead, onDelete }: { bead: Bead; onDelete?: () => void }) {
  return (
    <Card className="border-gray-700 bg-gray-800/50">
      <CardContent className="p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h4 className="line-clamp-2 text-sm font-medium text-gray-200">{bead.title}</h4>
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn('text-xs font-medium', priorityColors[bead.priority])}>
              {bead.priority}
            </span>
            {onDelete && (
              <button
                onClick={onDelete}
                className="rounded p-0.5 text-gray-600 hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {bead.type}
          </Badge>
          <span className="text-xs text-gray-500">
            {formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}
          </span>
        </div>
        {bead.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {bead.labels.map(label => (
              <Badge key={label} variant="secondary" className="text-xs">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BeadBoard({ beads, isLoading, onDeleteBead }: BeadBoardProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-3 gap-4">
        {statusColumns.map(status => (
          <div key={status}>
            <Skeleton className="mb-3 h-6 w-24" />
            <div className="space-y-2">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {statusColumns.map(status => {
        const columnBeads = beads.filter(b => b.status === status);
        return (
          <div key={status}>
            <div className="mb-3 flex items-center gap-2">
              <span
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs font-medium',
                  statusColors[status]
                )}
              >
                {statusLabels[status]}
              </span>
              <span className="text-xs text-gray-500">{columnBeads.length}</span>
            </div>
            <div className="space-y-2">
              {columnBeads.length === 0 && (
                <p className="py-4 text-center text-xs text-gray-600">No beads</p>
              )}
              {columnBeads.map(bead => (
                <BeadCard
                  key={bead.id}
                  bead={bead}
                  onDelete={onDeleteBead ? () => onDeleteBead(bead.id) : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
