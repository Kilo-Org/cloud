'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type BitbucketStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];
type RepositoryActionState =
  | 'not_connected'
  | 'reconnect_required'
  | 'workspace_selection_required'
  | 'insufficient_permissions'
  | 'temporarily_unavailable'
  | 'invalid_request'
  | null;

type BitbucketRepositoryCacheSectionProps = {
  organizationId: string;
  status: BitbucketStatus;
};

function TimestampValue({ timestamp }: { timestamp: string }) {
  return (
    <span title={new Date(timestamp).toLocaleString()}>
      <TimeAgo timestamp={timestamp} />
    </span>
  );
}

function RefreshFeedback({
  state,
  method,
}: {
  state: RepositoryActionState;
  method: BitbucketStatus['method'];
}) {
  if (!state) return null;
  if (state === 'temporarily_unavailable') {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Bitbucket is temporarily unavailable</AlertTitle>
        <AlertDescription>
          The repository cache was not changed. Wait a minute, then refresh repositories again.
        </AlertDescription>
      </Alert>
    );
  }

  const content = {
    insufficient_permissions: {
      title: 'Repository refresh needs more permissions',
      description: `The ${
        method === 'oauth' ? 'OAuth connection' : 'Workspace Access Token'
      } must include Account Read, Repository Read, Repository Write, and Webhooks Read and Write. Repository selection is disabled until access is restored. The last successful cache remains in the workspace status.`,
    },
    not_connected: {
      title: 'Bitbucket is not connected',
      description:
        'Repository selection is disabled. Connect the workspace again to restore access.',
    },
    workspace_selection_required: {
      title: 'Workspace selection required',
      description:
        'Repository selection is disabled until an organization owner or billing manager chooses a Bitbucket workspace.',
    },
    reconnect_required: {
      title: 'Bitbucket access needs attention',
      description:
        'Repository selection is disabled. Follow the recovery step shown for this integration. The last successful cache remains in the workspace status.',
    },
    invalid_request: {
      title: 'Repository refresh used stale integration details',
      description:
        'Repository selection is disabled. Reload the integration status before trying again.',
    },
  }[state];

  return (
    <Alert
      className={
        state === 'invalid_request'
          ? undefined
          : 'border-status-warning-border bg-status-warning-surface text-status-warning'
      }
    >
      <AlertCircle />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>{content.description}</AlertDescription>
    </Alert>
  );
}

export function BitbucketRepositoryCacheSection({
  organizationId,
  status,
}: BitbucketRepositoryCacheSectionProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [refreshFeedback, setRefreshFeedback] = useState<RepositoryActionState>(null);
  const previousValidation = useRef(status.lastValidatedAt);
  const statusInput = { organizationId };
  const statusQueryKey = trpc.organizations.bitbucket.getStatus.queryKey(statusInput);
  const repositoryQueryKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(statusInput);
  const cache = status.repositoryCache;

  useEffect(() => {
    if (previousValidation.current === status.lastValidatedAt) return;
    previousValidation.current = status.lastValidatedAt;
    setRefreshFeedback(null);
  }, [status.lastValidatedAt]);

  const refreshMutation = useMutation(
    trpc.organizations.bitbucket.refreshRepositories.mutationOptions({
      onSuccess: result => {
        switch (result.status) {
          case 'available':
            setRefreshFeedback(null);
            queryClient.setQueryData(repositoryQueryKey, result);
            toast.success('Bitbucket repositories refreshed');
            break;
          case 'temporarily_unavailable':
            setRefreshFeedback(result.status);
            break;
          case 'not_connected':
          case 'workspace_selection_required':
          case 'reconnect_required':
          case 'invalid_request':
          case 'insufficient_permissions':
            queryClient.setQueryData(repositoryQueryKey, result);
            setRefreshFeedback(result.status);
            break;
        }
        void queryClient.invalidateQueries({ queryKey: statusQueryKey });
      },
      onError: error => {
        toast.error("Couldn't refresh Bitbucket repositories", { description: error.message });
      },
    })
  );

  const refreshRepositories = () => {
    if (!status.integrationId) return;
    setRefreshFeedback(null);
    refreshMutation.mutate({ organizationId, integrationId: status.integrationId });
  };

  return (
    <>
      <RefreshFeedback state={refreshFeedback} method={status.method} />
      <section
        className="border-border space-y-4 border-t pt-6"
        aria-labelledby="bitbucket-repository-cache-heading"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 id="bitbucket-repository-cache-heading" className="type-heading">
              Repository cache{cache.status === 'available' && ` (${cache.repositories.length})`}
            </h2>
            <p className="text-muted-foreground text-xs">
              Last successful sync:{' '}
              {cache.syncedAt ? <TimestampValue timestamp={cache.syncedAt} /> : 'Not yet synced'}
            </p>
          </div>
          {status.canManage && status.integrationId && (
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch w-full sm:h-9 sm:min-h-0 sm:w-auto"
              disabled={refreshMutation.isPending || status.status !== 'connected'}
              onClick={refreshRepositories}
            >
              <RefreshCw
                className={
                  refreshMutation.isPending ? 'animate-spin motion-reduce:animate-none' : undefined
                }
              />
              {refreshMutation.isPending ? 'Refreshing repositories...' : 'Refresh repositories'}
            </Button>
          )}
        </div>

        {cache.status === 'uninitialized' ? (
          <p className="text-muted-foreground text-sm">
            The repository cache has not been initialized.
            {status.canManage
              ? ' Refresh repositories to try again.'
              : ' An organization owner or billing manager can initialize it.'}
          </p>
        ) : cache.repositories.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The repository cache is initialized and contains no repositories.
          </p>
        ) : (
          <ul className="border-border max-h-72 divide-y overflow-y-auto border-y">
            {cache.repositories.map(repository => (
              <li
                key={repository.id}
                className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-mono text-sm break-all">{repository.fullName}</span>
                <Badge variant="secondary" className="shrink-0">
                  {repository.private ? 'Private' : 'Public'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
