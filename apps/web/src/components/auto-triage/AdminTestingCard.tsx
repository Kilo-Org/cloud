'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ShieldCheck, Play, AlertCircle } from 'lucide-react';

type Props =
  | {
      owner: { type: 'org'; organizationId: string };
    }
  | {
      owner: { type: 'user' };
    };

/**
 * Admin-only form that submits an issue URL for triage, mirroring the
 * `issues.opened` webhook path. Visible only to admins — callers must
 * gate rendering with `session.user.is_admin`.
 *
 * The mutation creates an `auto_triage_tickets` row for the given owner
 * and kicks `tryDispatchPendingTickets`, producing exactly the state the
 * webhook handler would have produced.
 */
export function AdminTestingCard(props: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [issueUrl, setIssueUrl] = useState('');

  const mutation = useMutation(
    trpc.autoTriage.adminSubmitForTriage.mutationOptions({
      onSuccess: async result => {
        if (!result.success) return; // Unreachable — router throws instead of returning failureResult.
        toast.success(`Dispatched ticket ${result.ticketId}`, {
          description: `${result.repoFullName}#${result.issueNumber} — ${result.issueTitle}`,
        });
        setIssueUrl('');

        // Invalidate both list queries so the newly created ticket shows up
        // regardless of which one the parent page is rendering.
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: [['organizations', 'autoTriage', 'listTickets']],
          }),
          queryClient.invalidateQueries({
            queryKey: [['personalAutoTriage', 'listTickets']],
          }),
        ]);
      },
      onError: error => {
        toast.error('Failed to dispatch triage', { description: error.message });
      },
    })
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      issueUrl,
      owner: props.owner,
    });
  };

  // Surface the thrown error inline so the admin can iterate without
  // chasing toasts. Router throws TRPCError on all failure paths.
  const inlineError = mutation.error?.message ?? null;

  return (
    <Card className="border-amber-500/40 bg-amber-50/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-amber-500" />
          <CardTitle className="text-base">Admin: Submit issue for triage</CardTitle>
          <Badge variant="outline" className="border-amber-500/60 text-amber-500">
            Admin only
          </Badge>
        </div>
        <CardDescription>
          Paste a GitHub issue URL to dispatch it through the same path as an{' '}
          <code className="text-xs">issues.opened</code> webhook. Useful for exercising auto-triage
          locally without needing a real webhook delivery.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="admin-triage-issue-url">Issue URL</Label>
            <Input
              id="admin-triage-issue-url"
              type="url"
              placeholder="https://github.com/owner/repo/issues/123"
              value={issueUrl}
              onChange={e => setIssueUrl(e.target.value)}
              disabled={mutation.isPending}
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={mutation.isPending || !issueUrl.trim()}>
              <Play className="mr-2 h-3 w-3" />
              {mutation.isPending ? 'Dispatching…' : 'Dispatch triage'}
            </Button>
            {mutation.isPending && (
              <span className="text-muted-foreground text-xs">
                Fetching issue, creating ticket, dispatching to worker…
              </span>
            )}
          </div>
          {inlineError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>{inlineError}</span>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
