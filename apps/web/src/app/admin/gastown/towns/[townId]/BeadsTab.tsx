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
import { Checkbox } from '@/components/ui/checkbox';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Trash2 } from 'lucide-react';

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

type ConfirmAction =
  | { type: 'close' | 'fail'; beadId: string; title: string }
  | { type: 'bulk-delete'; beadIds: string[] }
  | { type: 'delete-all-failed'; count: number };

export function BeadsTab({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<BeadStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<BeadType | 'all'>('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const beadsQuery = useQuery(
    trpc.admin.gastown.listBeads.queryOptions({
      townId,
      status: statusFilter === 'all' ? undefined : statusFilter,
      type: typeFilter === 'all' ? undefined : typeFilter,
    })
  );

  const invalidateBeads = () => {
    void queryClient.invalidateQueries(trpc.admin.gastown.listBeads.queryFilter({ townId }));
  };

  const forceCloseMutation = useMutation(
    trpc.admin.gastown.forceCloseBead.mutationOptions({
      onSuccess: () => {
        invalidateBeads();
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
        invalidateBeads();
        setConfirmAction(null);
        toast.success('Bead marked as failed');
      },
      onError: err => {
        toast.error(`Failed to fail bead: ${err.message}`);
      },
    })
  );

  const bulkDeleteMutation = useMutation(
    trpc.admin.gastown.bulkDeleteBeads.mutationOptions({
      onSuccess: data => {
        invalidateBeads();
        setConfirmAction(null);
        setSelectedIds(new Set());
        toast.success(`Deleted ${data.deleted} bead${data.deleted === 1 ? '' : 's'}`);
      },
      onError: err => {
        toast.error(`Failed to delete beads: ${err.message}`);
      },
    })
  );

  const deleteByStatusMutation = useMutation(
    trpc.admin.gastown.deleteBeadsByStatus.mutationOptions({
      onSuccess: data => {
        invalidateBeads();
        setConfirmAction(null);
        setSelectedIds(new Set());
        toast.success(`Deleted ${data.deleted} bead${data.deleted === 1 ? '' : 's'}`);
      },
      onError: err => {
        toast.error(`Failed to delete beads: ${err.message}`);
      },
    })
  );

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'close') {
      forceCloseMutation.mutate({ townId, beadId: confirmAction.beadId });
    } else if (confirmAction.type === 'fail') {
      forceFailMutation.mutate({ townId, beadId: confirmAction.beadId });
    } else if (confirmAction.type === 'bulk-delete') {
      bulkDeleteMutation.mutate({ townId, beadIds: confirmAction.beadIds });
    } else {
      deleteByStatusMutation.mutate({
        townId,
        status: 'failed',
        type: typeFilter === 'all' ? undefined : typeFilter,
      });
    }
  };

  const beads = beadsQuery.data ?? [];
  const failedCount = beads.filter(b => b.status === 'failed').length;

  const allSelected = beads.length > 0 && beads.every(b => selectedIds.has(b.bead_id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(beads.map(b => b.bead_id)));
    }
  };

  const toggleSelect = (beadId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(beadId)) {
        next.delete(beadId);
      } else {
        next.add(beadId);
      }
      return next;
    });
  };

  const isPending =
    forceCloseMutation.isPending ||
    forceFailMutation.isPending ||
    bulkDeleteMutation.isPending ||
    deleteByStatusMutation.isPending;

  const confirmDialogTitle = () => {
    if (!confirmAction) return '';
    if (confirmAction.type === 'close') return 'Force Close Bead';
    if (confirmAction.type === 'fail') return 'Force Fail Bead';
    if (confirmAction.type === 'bulk-delete') return 'Delete Beads';
    return 'Delete All Failed Beads';
  };

  const confirmDialogDescription = () => {
    if (!confirmAction) return '';
    if (confirmAction.type === 'close') {
      return `This will force-close bead ${confirmAction.beadId.slice(0, 8)}…${confirmAction.title ? ` (${confirmAction.title})` : ''}. This action is logged in the audit trail.`;
    }
    if (confirmAction.type === 'fail') {
      return `This will force-fail bead ${confirmAction.beadId.slice(0, 8)}…${confirmAction.title ? ` (${confirmAction.title})` : ''}. This action is logged in the audit trail.`;
    }
    if (confirmAction.type === 'bulk-delete') {
      return `Delete ${confirmAction.beadIds.length} selected bead${confirmAction.beadIds.length === 1 ? '' : 's'}? This cannot be undone.`;
    }
    if (confirmAction.type === 'delete-all-failed') {
      return `Delete ${confirmAction.count} failed bead${confirmAction.count === 1 ? '' : 's'}? This cannot be undone.`;
    }
    return '';
  };

  const isDestructiveConfirm =
    confirmAction?.type === 'fail' ||
    confirmAction?.type === 'bulk-delete' ||
    confirmAction?.type === 'delete-all-failed';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Beads</CardTitle>
          <div className="flex gap-2">
            {/* Delete all failed shortcut */}
            {failedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-red-500/30 text-xs text-red-400 hover:bg-red-500/10"
                onClick={() => setConfirmAction({ type: 'delete-all-failed', count: failedCount })}
              >
                <Trash2 className="mr-1 size-3" />
                Delete all failed ({failedCount})
              </Button>
            )}

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

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="mt-2 flex items-center gap-3 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2">
            <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-red-500/30 text-xs text-red-400 hover:bg-red-500/10"
              onClick={() => setConfirmAction({ type: 'bulk-delete', beadIds: [...selectedIds] })}
            >
              <Trash2 className="mr-1 size-3" />
              Delete selected
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </Button>
          </div>
        )}
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
                  <th className="pb-2 pr-2">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all beads"
                    />
                  </th>
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
                    <td className="py-2 pr-2">
                      <Checkbox
                        checked={selectedIds.has(bead.bead_id)}
                        onCheckedChange={() => toggleSelect(bead.bead_id)}
                        aria-label={`Select bead ${bead.bead_id}`}
                      />
                    </td>
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
            <DialogTitle>{confirmDialogTitle()}</DialogTitle>
            <DialogDescription>{confirmDialogDescription()}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant={isDestructiveConfirm ? 'destructive' : 'default'}
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending
                ? 'Processing…'
                : confirmAction?.type === 'close'
                  ? 'Force Close'
                  : confirmAction?.type === 'fail'
                    ? 'Force Fail'
                    : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
