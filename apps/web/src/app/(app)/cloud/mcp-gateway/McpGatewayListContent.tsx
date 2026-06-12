'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Copy, Plus, Settings, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

type McpGatewayListContentProps = {
  organizationId?: string;
};

function remoteHost(remoteUrl: string) {
  try {
    return new URL(remoteUrl).host;
  } catch {
    return remoteUrl;
  }
}

export function McpGatewayListContent({ organizationId }: McpGatewayListContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routes = getMcpGatewayRoutes(organizationId);
  const [filter, setFilter] = useState('');
  const [deleteConfigId, setDeleteConfigId] = useState<string | null>(null);
  const listQuery = useQuery(
    organizationId
      ? trpc.mcpGateway.listOrganization.queryOptions({ organizationId })
      : trpc.mcpGateway.listPersonal.queryOptions()
  );
  const filteredConnections = useMemo(() => {
    const connections = listQuery.data ?? [];
    const query = filter.trim().toLowerCase();
    if (!query) return connections;
    return connections.filter(connection =>
      [connection.name, connection.remoteUrl, remoteHost(connection.remoteUrl), connection.authMode]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [filter, listQuery.data]);
  const deletingConnection = (listQuery.data ?? []).find(
    connection => connection.configId === deleteConfigId
  );
  const deleteMutation = useMutation(
    trpc.mcpGateway.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Connection deleted');
        setDeleteConfigId(null);
        void queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.mcpGateway.listOrganization.queryKey({ organizationId })
            : trpc.mcpGateway.listPersonal.queryKey(),
        });
      },
      onError: error => toast.error(error.message || 'Could not delete the connection'),
    })
  );

  async function copyConnectUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Connect URL copied');
    } catch {
      toast.error('Could not copy the connect URL');
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
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
        <CardHeader className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Connections</CardTitle>
              {!listQuery.isLoading && !listQuery.isError && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {filteredConnections.length}
                </span>
              )}
            </div>
            <CardDescription>Remote MCP servers available to Kilo Code.</CardDescription>
          </div>
          <Input
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder="Filter connections"
            aria-label="Filter connections"
            className="w-full sm:w-64"
          />
        </CardHeader>
        <CardContent className="px-6 pb-6 pt-0">
          {listQuery.isLoading && (
            <div className="space-y-3 rounded-lg border p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {listQuery.isError && (
            <div className="space-y-3 rounded-lg border p-5">
              <p className="text-sm">We couldn't load connections. Try again.</p>
              <Button variant="outline" onClick={() => listQuery.refetch()}>
                Retry loading connections
              </Button>
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && filteredConnections.length === 0 && (
            <div className="space-y-3 rounded-lg border p-5">
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
                <Button asChild variant="outline">
                  <Link href={routes.create}>
                    <Plus />
                    Create connection
                  </Link>
                </Button>
              )}
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && filteredConnections.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[720px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-36">Status</TableHead>
                    {organizationId && <TableHead className="w-32">Assigned users</TableHead>}
                    <TableHead className="w-40">Last updated</TableHead>
                    <TableHead className="w-28 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredConnections.map(connection => (
                    <TableRow key={connection.configId}>
                      <TableCell className="py-3">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            href={routes.detail(connection.configId)}
                            className="font-medium hover:underline"
                          >
                            {connection.name}
                          </Link>
                          <span className="text-muted-foreground font-mono text-xs">
                            {remoteHost(connection.remoteUrl)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <ConnectionStatusBadge connection={connection} />
                      </TableCell>
                      {organizationId && (
                        <TableCell className="tabular-nums">{connection.assignmentCount}</TableCell>
                      )}
                      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                        <span title={new Date(connection.updatedAt).toLocaleString()}>
                          {formatDistanceToNow(new Date(connection.updatedAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                asChild
                                variant="ghost"
                                size="icon"
                                aria-label={`Manage ${connection.name}`}
                              >
                                <Link href={routes.detail(connection.configId)}>
                                  <Settings />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Manage connection</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Copy connect URL for ${connection.name}`}
                                onClick={() => copyConnectUrl(connection.canonicalUrl)}
                              >
                                <Copy />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy connect URL</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${connection.name}`}
                                className="text-muted-foreground hover:text-foreground"
                                disabled={deleteMutation.isPending}
                                onClick={() => setDeleteConfigId(connection.configId)}
                              >
                                <Trash2 />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete connection</TooltipContent>
                          </Tooltip>
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
      <AlertDialog
        open={deleteConfigId !== null}
        onOpenChange={open => {
          if (!open) setDeleteConfigId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingConnection
                ? `${deletingConnection.name} will stop working immediately. Existing connect URLs and provider sign-ins for this connection will no longer be usable.`
                : 'This connection will stop working immediately. Existing connect URLs and provider sign-ins for this connection will no longer be usable.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Keep connection
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending || !deletingConnection}
              onClick={() => {
                if (!deletingConnection) return;
                deleteMutation.mutate({ configId: deletingConnection.configId, organizationId });
              }}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete connection'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
