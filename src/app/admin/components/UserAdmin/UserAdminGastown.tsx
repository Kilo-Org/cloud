'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDate } from '@/lib/admin-utils';
import { toast } from 'sonner';
import { ExternalLink, RotateCcw } from 'lucide-react';

type HealthDotProps = { status: 'green' | 'yellow' | 'red' | 'unknown' };

function HealthDot({ status }: HealthDotProps) {
  const colors = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-400',
    red: 'bg-red-500',
    unknown: 'bg-gray-400',
  };
  const labels = {
    green: 'Healthy',
    yellow: 'Degraded',
    red: 'Critical',
    unknown: 'Unknown',
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors[status]}`} />
      <span className="text-muted-foreground text-xs">{labels[status]}</span>
    </span>
  );
}

function deriveHealthStatus(
  health: {
    agents: { working: number; stalled: number; dead: number };
    beads: { failed: number };
    patrol: { guppEscalations: number; stalledAgents: number };
  } | null
): 'green' | 'yellow' | 'red' | 'unknown' {
  if (!health) return 'unknown';
  const { agents, beads, patrol } = health;
  if (agents.dead > 0 || patrol.guppEscalations > 0) return 'red';
  if (agents.stalled > 0 || beads.failed > 0 || patrol.stalledAgents > 0) return 'yellow';
  return 'green';
}

function TownRow({ town }: { town: { id: string; name: string; created_at: string } }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const healthQuery = useQuery({
    ...trpc.admin.gastown.getTownHealth.queryOptions({ townId: town.id }),
    retry: false,
  });

  const restartMutation = useMutation(
    trpc.admin.gastown.forceRestartContainer.mutationOptions({
      onSuccess: () => {
        toast.success(`Container restart requested for town ${town.name}`);
        void queryClient.invalidateQueries(
          trpc.admin.gastown.getTownHealth.queryOptions({ townId: town.id })
        );
      },
      onError: err => {
        toast.error(`Failed to restart container: ${err.message}`);
      },
    })
  );

  const health = healthQuery.data ?? null;
  const healthStatus = deriveHealthStatus(health);

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{town.name}</div>
        <div className="text-muted-foreground font-mono text-xs">{town.id}</div>
      </TableCell>
      <TableCell>
        {healthQuery.isLoading ? (
          <span className="text-muted-foreground text-xs">Loading…</span>
        ) : (
          <HealthDot status={healthStatus} />
        )}
      </TableCell>
      <TableCell className="text-sm">
        {health ? (
          <span className="text-muted-foreground">
            {health.agents.working} working / {health.agents.idle} idle
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {health ? (
          <span className="text-muted-foreground">
            {health.beads.open + health.beads.inProgress} open
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{formatDate(town.created_at)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/gastown/towns/${town.id}`}>
              <ExternalLink className="mr-1 h-3 w-3" />
              Inspect
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate({ townId: town.id })}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {restartMutation.isPending ? 'Restarting…' : 'Force Restart'}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function UserAdminGastown({ userId }: { userId: string }) {
  const trpc = useTRPC();

  const townsQuery = useQuery({
    ...trpc.admin.gastown.getUserTowns.queryOptions({ userId }),
    retry: false,
  });

  const rigsQuery = useQuery({
    ...trpc.admin.gastown.getUserRigs.queryOptions({ userId }),
    retry: false,
  });

  return (
    <Card className="col-span-1 lg:col-span-4">
      <CardHeader>
        <CardTitle>Gastown</CardTitle>
        <CardDescription>Towns and rigs owned by this user</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Towns */}
        <div>
          <h4 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Towns
          </h4>
          {townsQuery.isLoading && <p className="text-muted-foreground text-sm">Loading towns…</p>}
          {townsQuery.error && <p className="text-sm text-red-400">Failed to load towns</p>}
          {townsQuery.data && townsQuery.data.length === 0 && (
            <p className="text-muted-foreground text-sm">No towns found</p>
          )}
          {townsQuery.data && townsQuery.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Town</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Agents</TableHead>
                  <TableHead>Beads</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {townsQuery.data.map(town => (
                  <TownRow key={town.id} town={town} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Rigs */}
        <div>
          <h4 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Rigs
          </h4>
          {rigsQuery.isLoading && <p className="text-muted-foreground text-sm">Loading rigs…</p>}
          {rigsQuery.error && <p className="text-sm text-red-400">Failed to load rigs</p>}
          {rigsQuery.data && rigsQuery.data.length === 0 && (
            <p className="text-muted-foreground text-sm">No rigs found</p>
          )}
          {rigsQuery.data && rigsQuery.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rig Name</TableHead>
                  <TableHead>Git URL</TableHead>
                  <TableHead>Integration</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rigsQuery.data.map(rig => (
                  <TableRow key={rig.id}>
                    <TableCell>
                      <div className="font-medium">{rig.name}</div>
                      <div className="text-muted-foreground font-mono text-xs">{rig.id}</div>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground font-mono text-xs break-all">
                        {rig.git_url}
                      </span>
                    </TableCell>
                    <TableCell>
                      {rig.platform_integration_id ? (
                        <Badge variant="outline" className="border-green-500/30 text-green-400">
                          Linked
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Not linked
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(rig.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
