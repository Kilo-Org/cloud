'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/Button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { BeadEventTimeline } from '@/components/gastown/ActivityFeed';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { Clock, Flag, Hash, Tags, User } from 'lucide-react';

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

type GastownBeadDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bead: Bead | null;
  rigId: string;
  agentNameById?: Record<string, string>;
  onDelete?: () => void;
};

function MetaRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 text-white/40" />
      <div className="min-w-0">
        <div className="text-xs text-white/45">{label}</div>
        <div className="truncate text-sm text-white/85">{value}</div>
      </div>
    </div>
  );
}

export function GastownBeadDetailSheet({
  open,
  onOpenChange,
  bead,
  rigId,
  agentNameById,
  onDelete,
}: GastownBeadDetailSheetProps) {
  const assigneeName = bead?.assignee_agent_id ? agentNameById?.[bead.assignee_agent_id] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'w-[540px] max-w-[92vw] border-white/10 bg-[color:oklch(0.155_0_0)]',
          'shadow-[0_30px_120px_-70px_rgba(0,0,0,0.95)]'
        )}
      >
        <SheetHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="truncate text-base text-white/90">
                {bead?.title ?? 'Bead'}
              </SheetTitle>
              <SheetDescription className="mt-1 text-xs text-white/45">
                Click-through audit trail: events, status changes, hooks, and mail.
              </SheetDescription>
            </div>
            {onDelete && bead && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onDelete}
                className="shrink-0 border border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
              >
                Delete
              </Button>
            )}
          </div>

          {bead && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {bead.type}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {bead.status}
              </Badge>
              <Badge variant="outline" className="text-xs">
                <Flag className="size-3" />
                {bead.priority}
              </Badge>
            </div>
          )}
        </SheetHeader>

        <div className="space-y-4 px-4">
          {!bead ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/50">
              Select a bead to inspect details.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <MetaRow icon={Hash} label="Bead ID" value={bead.id} />
                <MetaRow
                  icon={Clock}
                  label="Created"
                  value={formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}
                />
                <MetaRow
                  icon={User}
                  label="Assignee"
                  value={
                    assigneeName ?? (bead.assignee_agent_id ? bead.assignee_agent_id : 'Unassigned')
                  }
                />
                <MetaRow
                  icon={Tags}
                  label="Labels"
                  value={bead.labels.length ? bead.labels.join(', ') : 'None'}
                />
              </div>

              {bead.body && bead.body.trim().length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="text-xs font-medium tracking-wide text-white/55">Body</div>
                  <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-white/80">
                    {bead.body}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="border-b border-white/10 px-4 py-3">
                  <div className="text-xs font-medium tracking-wide text-white/55">
                    Event Timeline
                  </div>
                  <div className="mt-1 text-xs text-white/40">
                    Append-only ledger for this bead.
                  </div>
                </div>
                <BeadEventTimeline rigId={rigId} beadId={bead.id} />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
