'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Copy, ExternalLink, Plus, RotateCw } from 'lucide-react';
import { toast } from 'sonner';

type McpGatewayListContentProps = {
  organizationId?: string;
};

function statusBadge(params: { enabled: boolean; activeGrantCount: number; authMode: string }) {
  if (!params.enabled) return <Badge variant="outline">Disabled</Badge>;
  if (params.authMode === 'none' || params.authMode === 'static_headers') {
    return <Badge variant="secondary">Ready</Badge>;
  }
  if (params.activeGrantCount > 0) return <Badge variant="secondary">Provider signed in</Badge>;
  return <Badge variant="outline">Needs sign-in</Badge>;
}

function authLabel(authMode: string) {
  switch (authMode) {
    case 'none':
      return 'No provider sign-in';
    case 'static_headers':
      return 'Static headers';
    case 'oauth_dynamic':
      return 'Provider sign-in';
    case 'oauth_static':
      return 'Provider sign-in';
    default:
      return authMode;
  }
}

export function McpGatewayListContent({ organizationId }: McpGatewayListContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routes = getMcpGatewayRoutes(organizationId);
  const [filter, setFilter] = useState('');
  const listQuery = useQuery(
    organizationId
      ? trpc.mcpGateway.listOrganization.queryOptions({ organizationId })
      : trpc.mcpGateway.listPersonal.queryOptions()
  );
  const rotateMutation = useMutation(
    trpc.mcpGateway.rotateRoute.mutationOptions({
      onSuccess: () => {
        toast.success('Connect URL rotated');
        void queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.mcpGateway.listOrganization.queryKey({ organizationId })
            : trpc.mcpGateway.listPersonal.queryKey(),
        });
      },
      onError: () => toast.error('Could not rotate the connect URL'),
    })
  );
  const filteredConnections = useMemo(() => {
    const connections = listQuery.data ?? [];
    const query = filter.trim().toLowerCase();
    if (!query) return connections;
    return connections.filter(connection =>
      [connection.name, connection.authMode, connection.sharingMode]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [filter, listQuery.data]);

  async function copyConnectUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Connect URL copied');
    } catch {
      toast.error('Could not copy the connect URL');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">MCP Gateway</h1>
          <p className="text-muted-foreground text-sm">
            Create and manage remote MCP server connections for Kilo Code.
          </p>
        </div>
        <Button asChild>
          <Link href={routes.create}>
            <Plus />
            Create connection
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Connections</CardTitle>
            <CardDescription>
              Remote MCP servers that can be connected through Kilo Code.
            </CardDescription>
          </div>
          <Input
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder="Filter connections"
            aria-label="Filter connections"
            className="w-full sm:w-64"
          />
        </CardHeader>
        <CardContent className="p-0">
          {listQuery.isLoading && (
            <div className="space-y-3 p-6">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {listQuery.isError && (
            <div className="space-y-3 p-6">
              <p className="text-sm">We couldn't load connections. Try again.</p>
              <Button variant="outline" onClick={() => listQuery.refetch()}>
                Retry loading connections
              </Button>
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && filteredConnections.length === 0 && (
            <div className="space-y-3 p-6">
              <p className="text-sm font-medium">
                {listQuery.data?.length
                  ? 'No connections match that filter.'
                  : 'No MCP connections yet.'}
              </p>
              <p className="text-muted-foreground text-sm">
                {listQuery.data?.length
                  ? 'Clear the filter to see every connection.'
                  : 'Create one to connect Kilo Code to a remote MCP server.'}
              </p>
              {listQuery.data?.length ? (
                <Button variant="outline" onClick={() => setFilter('')}>
                  Clear filter
                </Button>
              ) : (
                <Button asChild>
                  <Link href={routes.create}>
                    <Plus />
                    Create connection
                  </Link>
                </Button>
              )}
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && filteredConnections.length > 0 && (
            <div className="overflow-x-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Provider sign-in</TableHead>
                    <TableHead>Sharing</TableHead>
                    {organizationId && <TableHead>Assigned users</TableHead>}
                    <TableHead>Last updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredConnections.map(connection => (
                    <TableRow key={connection.configId}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Link
                            href={routes.detail(connection.configId)}
                            className="font-medium hover:underline"
                          >
                            {connection.name}
                          </Link>
                          <span className="text-muted-foreground font-mono text-xs">
                            {connection.canonicalUrl}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{statusBadge(connection)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {authLabel(connection.authMode)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {connection.sharingMode === 'single_user' ? 'Single user' : 'Shared'}
                      </TableCell>
                      {organizationId && (
                        <TableCell className="tabular-nums">{connection.assignmentCount}</TableCell>
                      )}
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(connection.updatedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Copy connect URL for ${connection.name}`}
                            onClick={() => copyConnectUrl(connection.canonicalUrl)}
                          >
                            <Copy />
                          </Button>
                          <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            aria-label={`Open ${connection.name}`}
                          >
                            <Link href={routes.detail(connection.configId)}>
                              <ExternalLink />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Rotate connect URL for ${connection.name}`}
                            onClick={() =>
                              rotateMutation.mutate({
                                configId: connection.configId,
                                organizationId,
                              })
                            }
                            disabled={rotateMutation.isPending}
                          >
                            <RotateCw />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
