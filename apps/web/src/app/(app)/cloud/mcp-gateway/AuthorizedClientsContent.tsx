'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

function permissionLabel(scope: string) {
  if (scope === 'mcp:access') return 'Read, write, and act through this MCP connection';
  if (scope === 'profile') return 'View your Kilo profile';
  return scope;
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
      {listQuery.data?.map(grant => (
        <Card key={grant.grantId}>
          <CardHeader className="gap-4 pb-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                <CardTitle className="min-w-0 break-words text-base">
                  Unverified MCP client
                </CardTitle>
              </div>
              <div className="text-muted-foreground font-mono text-xs break-all">
                {grant.clientId}
              </div>
              {grant.clientName && (
                <div className="text-muted-foreground min-w-0 text-xs break-words">
                  Self-reported name: {grant.clientName}
                </div>
              )}
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
            <div className="grid gap-4 border-t pt-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground text-xs uppercase">Connection</p>
                <p className="break-words font-medium">{grant.connectionName}</p>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground text-xs uppercase">Callback URI</p>
                <p className="font-mono text-xs break-all">{grant.redirectUri}</p>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground text-xs uppercase">Context</p>
                <Badge variant="outline" className="w-fit">
                  {grant.context.type === 'organization'
                    ? grant.context.organizationName
                    : 'Personal'}
                </Badge>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground text-xs uppercase">Authorized</p>
                <p title={new Date(grant.approvedAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(grant.approvedAt), { addSuffix: true })}
                </p>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground text-xs uppercase">Last used</p>
                <p
                  title={grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString() : undefined}
                >
                  {grant.lastUsedAt
                    ? formatDistanceToNow(new Date(grant.lastUsedAt), { addSuffix: true })
                    : 'Not used yet'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {grant.scopes.map(scope => (
                <Badge key={scope} variant="secondary">
                  {permissionLabel(scope)}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
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
