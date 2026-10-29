'use client';

import { useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OrganizationMcpConnectDecision } from '@kilocode/db/schema-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import {
  CLIENT_FILTER_OPTIONS,
  CONNECT_DECISION_OPTIONS,
  clientLabel,
  configIdentity,
  configKindLabel,
} from './addon-display';
import { formatConnectTime } from './format-connect-time';
import { McpConnectionUsersDialog } from './McpConnectionUsersDialog';

const ALL = 'all';

type DecisionFilter = OrganizationMcpConnectDecision | typeof ALL;

function UserCount({ count }: { count: number }) {
  return count === 0 ? (
    <span className="text-muted-foreground">–</span>
  ) : (
    <span className="tabular-nums">{count}</span>
  );
}

export function McpAuditLog({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [decision, setDecision] = useState<DecisionFilter>(ALL);
  const [client, setClient] = useState<string>(ALL);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const filters = {
    decision: decision === ALL ? undefined : decision,
    client: client === ALL ? undefined : client,
  };

  const connectionsQuery = useInfiniteQuery(
    trpc.organizations.addons.listConnections.infiniteQueryOptions(
      { organizationId, ...filters },
      { getNextPageParam: page => page.nextCursor ?? undefined }
    )
  );
  const connections = connectionsQuery.data?.pages.flatMap(page => page.connections) ?? [];
  const details = connections.find(connection => connection.identityKey === detailsKey) ?? null;

  const approveMutation = useMutation(
    trpc.organizations.addons.approveConnection.mutationOptions({
      onSuccess: async result => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.organizations.addons.list.queryKey({ organizationId }),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.organizations.addons.listConnections.pathKey(),
          }),
        ]);
        const source =
          result.matchedRegistry === 'kilo_marketplace'
            ? 'from the Kilo registry'
            : result.matchedRegistry === 'mcp_registry'
              ? 'from the MCP registry'
              : 'as a custom server';
        toast.success(`Allowed ${result.addon.name} ${source}.`);
      },
      onError: error => {
        toast.error(error.message || 'The MCP server couldn’t be approved. Try again.');
      },
    })
  );

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 id={titleId} className="text-sm font-semibold">
            Audit log
          </h3>
          <p className="text-muted-foreground text-sm">
            MCP server usage in your organization, from the past 90 days
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Select value={decision} onValueChange={value => setDecision(value as DecisionFilter)}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter by result">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All results</SelectItem>
              {CONNECT_DECISION_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={client} onValueChange={setClient}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter by client">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All clients</SelectItem>
              {CLIENT_FILTER_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {connectionsQuery.isPending ? (
        <Skeleton className="h-32 w-full" aria-busy="true" />
      ) : connectionsQuery.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-destructive text-sm">
            {connectionsQuery.error.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void connectionsQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">
            {decision === ALL && client === ALL
              ? 'No MCP connections yet'
              : 'No matching connections'}
          </p>
          <p className="text-muted-foreground max-w-md text-sm">
            {decision === ALL && client === ALL
              ? 'Connections appear here when members’ clients connect to an MCP server.'
              : 'Try a different result or client.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>MCP server</TableHead>
                <TableHead>Clients</TableHead>
                <TableHead className="text-right">Allowed</TableHead>
                <TableHead className="text-right">Denied</TableHead>
                <TableHead>Last connected</TableHead>
                <TableHead className="w-40">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map(connection => {
                const name = connection.serverName ?? configIdentity(connection.target);
                const approvePending =
                  approveMutation.isPending &&
                  approveMutation.variables.identityKey === connection.identityKey;
                const needsApproval = !connection.isOnAllowedList && connection.deniedUsers > 0;
                return (
                  <TableRow key={connection.identityKey}>
                    <TableCell className="max-w-sm">
                      <div className="grid gap-1">
                        <span className="truncate font-medium">{name}</span>
                        <span className="flex items-center gap-2">
                          <Badge variant="outline">{configKindLabel(connection.target)}</Badge>
                          <code className="text-muted-foreground truncate font-mono text-xs">
                            {configIdentity(connection.target)}
                          </code>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {connection.clients.map(item => (
                          <Badge key={item} variant="secondary">
                            {clientLabel(item)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <UserCount count={connection.allowedUsers} />
                    </TableCell>
                    <TableCell className="text-right">
                      <UserCount count={connection.deniedUsers} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatConnectTime(connection.lastSeenAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailsKey(connection.identityKey)}
                        >
                          Users
                        </Button>
                        {needsApproval && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={approvePending}
                            aria-label={`Approve ${name}`}
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId,
                                identityKey: connection.identityKey,
                              })
                            }
                          >
                            {approvePending ? 'Approving…' : 'Approve'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {connectionsQuery.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={connectionsQuery.isFetchingNextPage}
          onClick={() => void connectionsQuery.fetchNextPage()}
        >
          {connectionsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}

      {details && (
        <McpConnectionUsersDialog
          organizationId={organizationId}
          identityKey={details.identityKey}
          title={details.serverName ?? configIdentity(details.target)}
          decision={filters.decision}
          client={filters.client}
          onClose={() => setDetailsKey(null)}
        />
      )}
    </section>
  );
}
