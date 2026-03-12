'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
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

const AGENT_STATUS_COLORS: Record<string, string> = {
  working: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  idle: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  dead: 'bg-red-500/10 text-red-400 border-red-500/20',
  stalled: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

export function AgentsTab({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [agentToReset, setAgentToReset] = useState<{ id: string; name: string } | null>(null);

  const agentsQuery = useQuery(trpc.admin.gastown.listAgents.queryOptions({ townId }));

  const forceResetMutation = useMutation(
    trpc.admin.gastown.forceResetAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.admin.gastown.listAgents.queryFilter({ townId }));
        setAgentToReset(null);
        toast.success('Agent reset successfully');
      },
      onError: err => {
        toast.error(`Failed to reset agent: ${err.message}`);
      },
    })
  );

  const agents = agentsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
      </CardHeader>
      <CardContent>
        {agentsQuery.isLoading && (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading agents…</p>
        )}
        {agentsQuery.isError && (
          <p className="py-8 text-center text-sm text-red-400">
            Failed to load agents: {agentsQuery.error.message}
          </p>
        )}
        {!agentsQuery.isLoading && agents.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No agents found in this town.
          </p>
        )}
        {agents.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground pb-2 text-left font-medium">Agent</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Role</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Status</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Hooked Bead</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Dispatches</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Last Active</th>
                  <th className="text-muted-foreground pb-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(agent => (
                  <tr key={agent.id} className="hover:bg-muted/40 border-b transition-colors">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/admin/gastown/towns/${townId}/agents/${agent.id}`}
                        className="hover:text-foreground text-blue-400 transition-colors"
                      >
                        <div className="font-medium">{agent.name}</div>
                        <div className="text-muted-foreground font-mono text-xs">
                          {agent.id.slice(0, 8)}…
                        </div>
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs">{agent.role}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className={AGENT_STATUS_COLORS[agent.status] ?? ''}>
                        {agent.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4">
                      {agent.current_hook_bead_id ? (
                        <Link
                          href={`/admin/gastown/towns/${townId}/beads/${agent.current_hook_bead_id}`}
                          className="text-muted-foreground hover:text-foreground font-mono text-xs transition-colors"
                        >
                          {agent.current_hook_bead_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="text-muted-foreground py-2 pr-4 text-center text-xs">
                      {agent.dispatch_attempts}
                    </td>
                    <td className="text-muted-foreground py-2 pr-4 text-xs">
                      {agent.last_activity_at
                        ? formatDistanceToNow(new Date(agent.last_activity_at), {
                            addSuffix: true,
                          })
                        : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => setAgentToReset({ id: agent.id, name: agent.name })}
                      >
                        Force Reset
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!agentToReset} onOpenChange={() => setAgentToReset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force Reset Agent</DialogTitle>
            <DialogDescription>
              This will reset agent <span className="font-semibold">{agentToReset?.name}</span> to
              idle status and unhook any hooked bead. This action is logged in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAgentToReset(null)}
              disabled={forceResetMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                agentToReset && forceResetMutation.mutate({ townId, agentId: agentToReset.id })
              }
              disabled={forceResetMutation.isPending}
            >
              {forceResetMutation.isPending ? 'Resetting…' : 'Force Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
