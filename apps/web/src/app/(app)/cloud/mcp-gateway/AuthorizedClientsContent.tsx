'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { ShieldCheck, ShieldX, ChevronDown } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';

function permissionLabel(scope: string) {
  if (scope === 'mcp:access') return 'Read, write, and act through this MCP connection';
  if (scope === 'profile') return 'View your Kilo profile';
  return scope;
}

function isBroadAccessScope(scope: string) {
  return scope === 'mcp:access';
}

type AuthorizedClientsContentProps = {
  organizationId?: string;
};

export function AuthorizedClientsContent({ organizationId }: AuthorizedClientsContentProps = {}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [revokeGrantId, setRevokeGrantId] = useState<string | null>(null);
  const queryInput = organizationId ? { organizationId } : ({ ownerScope: 'personal' } as const);
  const listQuery = useQuery(trpc.mcpGatewayAuthorizations.listMine.queryOptions(queryInput));
  const revokeTarget = (listQuery.data ?? []).find(grant => grant.grantId === revokeGrantId);
  const revokeMutation = useMutation(
    trpc.mcpGatewayAuthorizations.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Client access revoked');
        if (revokeGrantId) {
          queryClient.setQueryData(
            trpc.mcpGatewayAuthorizations.listMine.queryKey(queryInput),
            (current: typeof listQuery.data) =>
              current?.filter(grant => grant.grantId !== revokeGrantId) ?? current
          );
        }
        setRevokeGrantId(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.mcpGatewayAuthorizations.listMine.queryKey(queryInput),
        });
      },
      onError: error => toast.error(error.message || "We couldn't revoke client access"),
    })
  );

  return (
    <div className="space-y-4">
      {listQuery.isLoading && !listQuery.data && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      )}
      {listQuery.isError && !listQuery.data && (
        <div className="space-y-3 rounded-lg border p-5" role="alert">
          <p className="text-sm">We couldn't load authorized clients. Try again.</p>
          <Button
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => listQuery.refetch()}
          >
            {listQuery.isFetching ? 'Retrying...' : 'Retry loading authorized clients'}
          </Button>
        </div>
      )}
      {listQuery.isError && listQuery.data && (
        <div
          className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm"
          role="status"
        >
          <p className="text-muted-foreground">
            Showing the last loaded list. We couldn't refresh authorized clients.
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={listQuery.isFetching}
            onClick={() => listQuery.refetch()}
          >
            {listQuery.isFetching ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      )}
      {listQuery.data?.length === 0 && (
        <div className="space-y-3 rounded-lg border p-6">
          <ShieldCheck className="text-muted-foreground size-5" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No authorized clients</p>
            <p className="text-muted-foreground text-sm">
              MCP clients you authorize to use connections on your behalf will appear here. Start
              from an MCP connection URL when your client asks to authenticate.
            </p>
          </div>
        </div>
      )}
      {listQuery.data?.map(grant => {
        const connectionHref = getMcpGatewayRoutes(
          grant.context.type === 'organization' ? grant.context.organizationId : undefined
        ).detail(grant.configId);
        const onBehalfOf =
          grant.context.type === 'organization' ? grant.context.organizationName : 'yourself';
        const hasBroadAccess = grant.scopes.some(isBroadAccessScope);
        const otherScopes = grant.scopes.filter(scope => !isBroadAccessScope(scope));
        return (
          <Card key={grant.grantId}>
            <CardHeader className="gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Unverified client"
                        className="text-muted-foreground focus-visible:ring-ring inline-flex shrink-0 cursor-help items-center rounded-sm focus-visible:ring-1 focus-visible:outline-none"
                      >
                        <ShieldCheck className="size-4" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Unverified — this name was provided by the client and has not been confirmed.
                    </TooltipContent>
                  </Tooltip>
                  <h2 className="min-w-0 truncate text-base font-semibold tracking-tight">
                    {grant.clientName ? `“${grant.clientName}”` : 'Unverified MCP client'}
                  </h2>
                </div>
                <p className="text-muted-foreground text-sm">
                  Authorized to use{' '}
                  <Link
                    href={connectionHref}
                    className="text-foreground font-medium underline-offset-2 hover:underline"
                  >
                    {grant.connectionName}
                  </Link>{' '}
                  on behalf of <span className="text-foreground">{onBehalfOf}</span>
                </p>
              </div>
              <Button
                variant="outline"
                className="h-10 w-full sm:h-9 sm:w-auto"
                disabled={revokeMutation.isPending}
                onClick={() => setRevokeGrantId(grant.grantId)}
              >
                <ShieldX className="size-4" />
                Revoke access
              </Button>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              {hasBroadAccess && (
                <div className="bg-muted/40 space-y-1 rounded-md border p-3">
                  <p className="text-muted-foreground text-xs font-medium uppercase">
                    What this grants
                  </p>
                  <p className="text-sm">
                    Read, write, and act through{' '}
                    <span className="font-medium">{grant.connectionName}</span> on your behalf,
                    using whatever tools that connection exposes.
                  </p>
                  {otherScopes.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {otherScopes.map(scope => (
                        <Badge key={scope} variant="secondary">
                          {permissionLabel(scope)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                <span title={new Date(grant.approvedAt).toLocaleString()}>
                  Authorized {formatDistanceToNow(new Date(grant.approvedAt), { addSuffix: true })}
                </span>
                <span aria-hidden="true" className="opacity-60">
                  ·
                </span>
                <span
                  title={grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString() : undefined}
                >
                  {grant.lastUsedAt
                    ? `Last used ${formatDistanceToNow(new Date(grant.lastUsedAt), { addSuffix: true })}`
                    : 'Not used yet'}
                </span>
              </div>
              <details className="group border-t pt-3">
                <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium select-none focus-visible:ring-1 focus-visible:outline-none">
                  <ChevronDown
                    className="size-3.5 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                  Show technical details
                </summary>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <dt className="text-muted-foreground text-xs uppercase">Client ID</dt>
                    <dd className="bg-muted/40 rounded-sm px-2 py-1 font-mono text-xs break-all">
                      {grant.clientId}
                    </dd>
                  </div>
                  <div className="min-w-0 space-y-1">
                    <dt className="text-muted-foreground text-xs uppercase">Callback URI</dt>
                    <dd className="bg-muted/40 rounded-sm px-2 py-1 font-mono text-xs break-all">
                      {grant.redirectUri}
                    </dd>
                  </div>
                </dl>
              </details>
            </CardContent>
          </Card>
        );
      })}
      <AlertDialog
        open={revokeGrantId !== null}
        onOpenChange={open => {
          if (!open) setRevokeGrantId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access for this client?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {revokeTarget ? (
                <div className="space-y-3 text-sm">
                  <p>
                    This unverified client will immediately lose access to{' '}
                    <span className="font-medium">{revokeTarget.connectionName}</span>. It must be
                    authorized again before it can use this MCP connection.
                  </p>
                  <dl className="space-y-2">
                    <div>
                      <dt className="text-muted-foreground text-xs uppercase">Client ID</dt>
                      <dd className="bg-muted/50 mt-1 rounded-md px-2 py-1 font-mono text-xs break-all">
                        {revokeTarget.clientId}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs uppercase">Callback URI</dt>
                      <dd className="bg-muted/50 mt-1 rounded-md px-2 py-1 font-mono text-xs break-all">
                        {revokeTarget.redirectUri}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <p>
                  This unverified client will immediately lose access to this MCP connection. It
                  must be authorized again before it can use the connection.
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Keep access</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revokeMutation.isPending || !revokeTarget}
              onClick={() => {
                if (!revokeTarget) return;
                revokeMutation.mutate({ grantId: revokeTarget.grantId });
              }}
            >
              {revokeMutation.isPending ? 'Revoking...' : 'Revoke access'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
