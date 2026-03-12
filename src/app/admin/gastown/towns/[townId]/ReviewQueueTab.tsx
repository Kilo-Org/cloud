'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { ExternalLink } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  closed: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

type EntryToRetry = { id: string; title: string };

export function ReviewQueueTab({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [entryToRetry, setEntryToRetry] = useState<EntryToRetry | null>(null);

  // Fetch in-progress merge request beads as the review queue
  const inProgressQuery = useQuery(
    trpc.admin.gastown.listBeads.queryOptions({
      townId,
      type: 'merge_request',
      status: 'in_progress',
    })
  );

  const openQuery = useQuery(
    trpc.admin.gastown.listBeads.queryOptions({
      townId,
      type: 'merge_request',
      status: 'open',
    })
  );

  const forceRetryMutation = useMutation(
    trpc.admin.gastown.forceRetryReview.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.admin.gastown.listBeads.queryFilter({ townId }));
        setEntryToRetry(null);
        toast.success('Review retry requested');
      },
      onError: err => {
        toast.error(`Failed to retry review: ${err.message}`);
      },
    })
  );

  const queueEntries = [...(inProgressQuery.data ?? []), ...(openQuery.data ?? [])];
  const isLoading = inProgressQuery.isLoading || openQuery.isLoading;
  const isError = inProgressQuery.isError || openQuery.isError;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Queue</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading review queue…</p>
        )}
        {isError && (
          <p className="py-8 text-center text-sm text-red-400">Failed to load review queue.</p>
        )}
        {!isLoading && queueEntries.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No active review queue entries.
          </p>
        )}
        {queueEntries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground pb-2 text-left font-medium">Bead</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">PR URL</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">
                    Assigned Agent
                  </th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">
                    Time in Queue
                  </th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Status</th>
                  <th className="text-muted-foreground pb-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queueEntries.map(entry => {
                  const prUrl =
                    typeof entry.metadata['pr_url'] === 'string' &&
                    /^https?:\/\//.test(entry.metadata['pr_url'])
                      ? entry.metadata['pr_url']
                      : null;
                  return (
                    <tr
                      key={entry.bead_id}
                      className="hover:bg-muted/40 border-b transition-colors"
                    >
                      <td className="py-2 pr-4">
                        <Link
                          href={`/admin/gastown/towns/${townId}/beads/${entry.bead_id}`}
                          className="hover:text-foreground text-blue-400 transition-colors"
                        >
                          <div className="max-w-64 truncate">{entry.title}</div>
                          <div className="text-muted-foreground font-mono text-xs">
                            {entry.bead_id.slice(0, 8)}…
                          </div>
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        {prUrl ? (
                          <a
                            href={prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-blue-400 hover:underline"
                          >
                            <span className="max-w-40 truncate text-xs">{prUrl}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {entry.assignee_agent_bead_id ? (
                          <Link
                            href={`/admin/gastown/towns/${townId}/agents/${entry.assignee_agent_bead_id}`}
                            className="text-muted-foreground hover:text-foreground font-mono text-xs transition-colors"
                          >
                            {entry.assignee_agent_bead_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="text-muted-foreground py-2 pr-4 text-xs">
                        {formatDistanceToNow(new Date(entry.created_at), { addSuffix: false })}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className={STATUS_COLORS[entry.status] ?? ''}>
                          {entry.status}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled
                          title="Review retry not yet implemented"
                        >
                          Force Retry
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!entryToRetry} onOpenChange={() => setEntryToRetry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force Retry Review</DialogTitle>
            <DialogDescription>
              This will force-retry the review for{' '}
              <span className="font-semibold">{entryToRetry?.title}</span>. This action is logged in
              the audit trail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEntryToRetry(null)}
              disabled={forceRetryMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                entryToRetry && forceRetryMutation.mutate({ townId, entryId: entryToRetry.id })
              }
              disabled={forceRetryMutation.isPending}
            >
              {forceRetryMutation.isPending ? 'Retrying…' : 'Force Retry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
