'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';

type Bead = {
  bead_id: string;
  type: string;
  status: string;
  title: string;
  body: string | null;
  assignee_agent_bead_id: string | null;
  priority: string;
  labels: string[];
  created_at: string;
  closed_at: string | null;
};

type BeadBoardProps = {
  beads: Bead[];
  isLoading: boolean;
  onDeleteBead?: (beadId: string) => void;
  onSelectBead?: (bead: Bead) => void;
  selectedBeadId?: string | null;
  agentNameById?: Record<string, string>;
};

const statusColumns = ['open', 'in_progress', 'in_review', 'closed'] as const;

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  in_review: 'In Review',
  closed: 'Closed',
};

const statusColors: Record<string, string> = {
  open: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  in_review: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  closed: 'bg-green-500/10 text-green-400 border-green-500/20',
};

const priorityColors: Record<string, string> = {
  low: 'text-white/55',
  medium: 'text-sky-300',
  high: 'text-amber-300',
  critical: 'text-red-300',
};

function BeadCard({
  bead,
  onDelete,
  onSelect,
  isSelected,
  agentNameById,
}: {
  bead: Bead;
  onDelete?: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
  agentNameById?: Record<string, string>;
}) {
  const assigneeName = bead.assignee_agent_bead_id
    ? agentNameById?.[bead.assignee_agent_bead_id]
    : null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <Card
      className={cn(
        'group border-white/10 bg-white/[0.03] transition-[border-color,background-color,transform] hover:bg-white/[0.05]',
        onSelect ? 'cursor-pointer' : 'cursor-default',
        isSelected
          ? 'border-[color:oklch(95%_0.15_108_/_0.45)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
          : ''
      )}
    >
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full text-left',
          onSelect
            ? 'focus-visible:ring-2 focus-visible:ring-[color:oklch(95%_0.15_108_/_0.35)]'
            : '',
          'focus-visible:ring-offset-0 focus-visible:outline-none'
        )}
      >
        <CardContent className="p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <h4 className="line-clamp-2 text-sm font-medium text-white/90">{bead.title}</h4>
            <div className="flex shrink-0 items-center gap-1">
              <span className={cn('text-xs font-medium', priorityColors[bead.priority])}>
                {bead.priority}
              </span>
              {onDelete && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="rounded p-0.5 text-white/40 transition-colors hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {bead.type}
            </Badge>
            <span className="text-xs text-white/50">
              {formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}
            </span>
            {assigneeName && (
              <span className="text-xs text-white/50">
                <span className="text-white/30">assigned</span> {assigneeName}
              </span>
            )}
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
      </div>
    </Card>
  );
}

export function BeadBoard({
  beads,
  isLoading,
  onDeleteBead,
  onSelectBead,
  selectedBeadId,
  agentNameById,
}: BeadBoardProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
      {statusColumns.map((status, colIdx) => {
        const columnBeads = beads.filter(b => b.status === status && b.type !== 'agent');
        return (
          <motion.div
            key={status}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: colIdx * 0.08, duration: 0.3 }}
          >
            <div className="mb-3 flex items-center gap-2">
              <span
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs font-medium',
                  statusColors[status]
                )}
              >
                {statusLabels[status]}
              </span>
              <motion.span
                key={columnBeads.length}
                initial={{ scale: 1.3, opacity: 0.5 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-xs text-white/45"
              >
                {columnBeads.length}
              </motion.span>
            </div>
            <div className="space-y-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {columnBeads.length === 0 && (
                  <motion.p
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="py-4 text-center text-xs text-white/35"
                  >
                    No beads
                  </motion.p>
                )}
                {columnBeads.map(bead => (
                  <motion.div
                    key={bead.bead_id}
                    layout
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -10 }}
                    transition={{
                      layout: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
                      opacity: { duration: 0.2 },
                      scale: { duration: 0.2 },
                    }}
                  >
                    <BeadCard
                      bead={bead}
                      onDelete={onDeleteBead ? () => onDeleteBead(bead.bead_id) : undefined}
                      onSelect={onSelectBead ? () => onSelectBead(bead) : undefined}
                      isSelected={selectedBeadId === bead.bead_id}
                      agentNameById={agentNameById}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
