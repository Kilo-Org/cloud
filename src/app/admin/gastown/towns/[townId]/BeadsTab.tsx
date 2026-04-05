'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

const beadStatuses = ['open', 'in_progress', 'closed', 'failed'] as const;
type BeadStatus = (typeof beadStatuses)[number];

const beadTypes = [
  'issue',
  'message',
  'escalation',
  'merge_request',
  'convoy',
  'molecule',
  'agent',
] as const;
type BeadType = (typeof beadTypes)[number];

const STATUS_COLORS: Record<BeadStatus, string> = {
  open: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  closed: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

type ConfirmAction = {
  type: 'close' | 'fail';
  beadId: string;
  title: string;
};

export function BeadsTab({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<BeadStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<BeadType | 'all'>('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const beadsQuery = useQuery(
    trpc.admin.gastown.listBeads.queryOptions({
      townId,
      status: statusFilter === 'all' ? undefined : statusFilter,
      type: typeFilter === 'all' ? undefined : typeFilter,
    })
  );

  const forceCloseMutation = useMutation(
    trpc.admin.gastown.forceCloseBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.admin.gastown.listBeads.queryFilter({ townId }));
        setConfirmAction(null);
        toast.success('Bead closed successfully');
      },
      onError: err => {
        toast.error(`Failed to close bead: ${err.message}`);
      },
    })
  );

  const forceFailMutation = useMutation(
    trpc.admin.gastown.forceFailBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.admin.gastown.listBeads.queryFilter({ townId }));
        setConfirmAction(null);
        toast.success('Bead marked as failed');
      },
      onError: err => {
        toast.error(`Failed to fail bead: ${err.message}`);
      },
    })
  );

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'close') {
      forceCloseMutation.mutate({ townId, beadId: confirmAction.beadId });
    } else {
      forceFailMutation.mutate({ townId, beadId: confirmAction.beadId });
    }
  };

  const beads = beadsQuery.data ?? [];
  const isPending = forceCloseMutation.isPending || forceFailMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Beads</CardTitle>
          <div className="flex gap-2">
            <Select
              value={statusFilter}
              onValueChange={v => {
                if (v === 'all' || (beadStatuses as readonly string[]).includes(v))
                  setStatusFilter(v as BeadStatus | 'all');
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={typeFilter}
              onValueChange={v => {
                if (v === 'all' || (beadTypes as readonly string[]).includes(v))
                  setTypeFilter(v as BeadType | 'all');
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="issue">Issue</SelectItem>
                <SelectItem value="merge_request">Merge Request</SelectItem>
                <SelectItem value="convoy">Convoy</SelectItem>
                <SelectItem value="escalation">Escalation</SelectItem>
                <SelectItem value="message">Message</SelectItem>
                <SelectItem value="molecule">Molecule</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {beadsQuery.isLoading && (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading beads…</p>
        )}
        {beadsQuery.isError && (
          <p className="py-8 text-center text-sm text-red-400">
            Failed to load beads: {beadsQuery.error.message}
          </p>
        )}
        {!beadsQuery.isLoading && beads.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No beads found matching the current filters.
          </p>
        )}
        {beads.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground pb-2 text-left font-medium">Bead</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Type</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Status</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Agent</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Created</th>
                  <th className="text-muted-foreground pb-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {beads.map(bead => (
                  <tr key={bead.bead_id} className="hover:bg-muted/40 border-b transition-colors">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/admin/gastown/towns/${townId}/beads/${bead.bead_id}`}
                        className="hover:text-foreground text-blue-400 transition-colors"
                      >
                        <span className="font-mono text-xs">{bead.bead_id.slice(0, 8)}…</span>
                        {bead.title && <span className="ml-2 max-w-64 truncate">{bead.title}</span>}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs">{bead.type}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className={STATUS_COLORS[bead.status]}>
                        {bead.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4">
                      {bead.assignee_agent_bead_id ? (
                        <Link
                          href={`/admin/gastown/towns/${townId}/agents/${bead.assignee_agent_bead_id}`}
                          className="text-muted-foreground hover:text-foreground font-mono text-xs transition-colors"
                        >
                          {bead.assignee_agent_bead_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="text-muted-foreground py-2 pr-4 text-xs">
                      {formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={bead.status === 'closed' || bead.status === 'failed'}
                          onClick={() =>
                            setConfirmAction({
                              type: 'close',
                              beadId: bead.bead_id,
                              title: bead.title,
                            })
                          }
                        >
                          Force Close
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-red-500/30 text-xs text-red-400 hover:bg-red-500/10"
                          disabled={bead.status === 'closed' || bead.status === 'failed'}
                          onClick={() =>
                            setConfirmAction({
                              type: 'fail',
                              beadId: bead.bead_id,
                              title: bead.title,
                            })
                          }
                        >
                          Force Fail
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === 'close' ? 'Force Close Bead' : 'Force Fail Bead'}
            </DialogTitle>
            <DialogDescription>
              This will {confirmAction?.type === 'close' ? 'force-close' : 'force-fail'} bead{' '}
              <span className="font-mono">{confirmAction?.beadId.slice(0, 8)}…</span>
              {confirmAction?.title ? ` (${confirmAction.title})` : ''}. This action is logged in
              the audit trail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant={confirmAction?.type === 'fail' ? 'destructive' : 'default'}
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending
                ? 'Processing…'
                : confirmAction?.type === 'close'
                  ? 'Force Close'
                  : 'Force Fail'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
