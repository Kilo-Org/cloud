'use client';

import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, CheckCircle2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
import { BitbucketLogo } from '@/components/auth/BitbucketLogo';
import { BitbucketIntegrationControls } from '@/components/integrations/BitbucketIntegrationControls';
import { BitbucketRepositoryCacheSection } from '@/components/integrations/BitbucketRepositoryCacheSection';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type BitbucketStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];
type RecoveryAction = 'replace_token' | 'disconnect_and_connect' | null;

type BitbucketConnectedManagementProps = {
  organizationId: string;
  status: BitbucketStatus;
  statusRefetchFailed: boolean;
};

export function getRecoveryGuidance(
  method: BitbucketStatus['method'],
  recoveryAction: RecoveryAction,
  invalidationReason: string | null,
  canManage: boolean
): string {
  if (method === 'oauth') {
    const nextStep = canManage
      ? 'Disconnect Bitbucket from Kilo, then connect it again with OAuth.'
      : 'Ask an organization owner or billing manager to disconnect Bitbucket and connect it again with OAuth.';
    return `The Bitbucket OAuth connection cannot use its current credential. ${nextStep}`;
  }

  const problem =
    invalidationReason === 'expired'
      ? 'The token has expired.'
      : invalidationReason === 'provider_rejected'
        ? 'Bitbucket rejected the token.'
        : invalidationReason === 'workspace_mismatch'
          ? 'The token no longer matches this workspace.'
          : invalidationReason === 'encryption_unreadable'
            ? 'Kilo can no longer read the encrypted token.'
            : 'The Bitbucket integration cannot use its current credential.';

  if (recoveryAction === 'disconnect_and_connect') {
    const nextStep = canManage
      ? 'Disconnect Bitbucket from Kilo, then connect the workspace again with a new Workspace Access Token.'
      : 'Ask an organization owner or billing manager to disconnect Bitbucket and connect the workspace again.';
    return `${problem} ${nextStep}`;
  }
  if (recoveryAction === 'replace_token') {
    const nextStep = canManage
      ? 'Replace the token to restore provider access.'
      : 'Ask an organization owner or billing manager to replace the token.';
    return `${problem} ${nextStep}`;
  }
  return problem;
}

export function BitbucketAdditionalPermissionsWarning({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) return null;

  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>Token has additional permissions</AlertTitle>
      <AlertDescription>
        <span>
          Kilo did not request these permissions: <code>{scopes.join(', ')}</code>
        </span>
        <span>
          Cloud Agent sessions can use the token&apos;s full workspace access. Replace the token
          with only the required permissions if this is not intentional.
        </span>
      </AlertDescription>
    </Alert>
  );
}

function StatusBadge({ status }: { status: BitbucketStatus['status'] }) {
  if (status === 'connected') {
    return (
      <Badge className="border-status-success-border bg-status-success-surface text-status-success rounded-full border">
        <CheckCircle2 className="text-status-success-icon" />
        Connected
      </Badge>
    );
  }
  return (
    <Badge className="border-status-warning-border bg-status-warning-surface text-status-warning rounded-full border">
      <AlertCircle className="text-status-warning-icon" />
      Action required
    </Badge>
  );
}

function TimestampValue({ timestamp }: { timestamp: string | null }) {
  if (!timestamp) return <span>Not recorded</span>;
  return (
    <span title={new Date(timestamp).toLocaleString()}>
      <TimeAgo timestamp={timestamp} />
    </span>
  );
}

function MethodLabel({ method }: { method: BitbucketStatus['method'] }) {
  return method === 'oauth' ? 'OAuth' : 'Workspace Access Token';
}

function WorkspaceStatus({ status }: { status: BitbucketStatus }) {
  return (
    <section className="space-y-4" aria-labelledby="bitbucket-workspace-status-heading">
      <h2 id="bitbucket-workspace-status-heading" className="type-heading">
        Workspace status
      </h2>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <dt className="text-muted-foreground type-label">Method</dt>
          <dd className="text-sm">
            <MethodLabel method={status.method} />
          </dd>
        </div>
        {status.method === 'oauth' && 'authorizingNickname' in status && (
          <div className="space-y-1">
            <dt className="text-muted-foreground type-label">Authorized account</dt>
            <dd className="font-mono text-sm break-all">
              {status.authorizingNickname ?? 'Not available'}
            </dd>
          </div>
        )}
        <div className="space-y-1">
          <dt className="text-muted-foreground type-label">Display name</dt>
          <dd className="text-sm">{status.workspace?.displayName ?? 'Not available'}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground type-label">Canonical slug</dt>
          <dd className="font-mono text-sm break-all">
            {status.workspace?.slug ?? 'Not available'}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground type-label">Workspace UUID</dt>
          <dd className="font-mono text-sm break-all">
            {status.workspace?.uuid ?? 'Not available'}
          </dd>
        </div>
        {status.method === 'workspace_access_token' && (
          <div className="space-y-1">
            <dt className="text-muted-foreground type-label">Last validation</dt>
            <dd className="text-sm">
              <TimestampValue timestamp={status.lastValidatedAt} />
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function workspaceKey(workspace: { uuid: string; slug: string }) {
  return `${workspace.uuid}:${workspace.slug}`;
}

function BitbucketOAuthWorkspaceSelection({
  organizationId,
  status,
}: {
  organizationId: string;
  status: Extract<BitbucketStatus, { status: 'workspace_selection_required' }>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const availableWorkspaces = 'availableWorkspaces' in status ? status.availableWorkspaces : [];
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState(
    availableWorkspaces[0] ? workspaceKey(availableWorkspaces[0]) : ''
  );
  const selectedWorkspace = availableWorkspaces.find(
    workspace => workspaceKey(workspace) === selectedWorkspaceKey
  );
  const statusInput = { organizationId };
  const statusQueryKey = trpc.organizations.bitbucket.getStatus.queryKey(statusInput);
  const repositoryQueryKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(statusInput);
  const mutation = useMutation(
    trpc.organizations.bitbucket.selectWorkspace.mutationOptions({
      onSuccess: () => {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQueryKey }),
          queryClient.invalidateQueries({ queryKey: repositoryQueryKey }),
        ]);
        toast.success('Bitbucket workspace selected');
      },
      onError: error => {
        toast.error("Couldn't select the Bitbucket workspace", { description: error.message });
      },
    })
  );

  if (!status.canManage) {
    return (
      <Alert>
        <ShieldCheck />
        <AlertTitle>Workspace selection required</AlertTitle>
        <AlertDescription>
          An organization owner or billing manager must choose the Bitbucket workspace before
          repository access is available.
        </AlertDescription>
      </Alert>
    );
  }

  if (availableWorkspaces.length === 0) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>No Bitbucket workspaces available</AlertTitle>
        <AlertDescription>
          Disconnect Bitbucket, then connect OAuth again with an account that can access the
          workspace.
        </AlertDescription>
      </Alert>
    );
  }

  const selectWorkspace = () => {
    if (!selectedWorkspace) return;
    mutation.mutate({
      organizationId,
      workspaceUuid: selectedWorkspace.uuid,
      workspaceSlug: selectedWorkspace.slug,
    });
  };

  return (
    <section className="space-y-4" aria-labelledby="bitbucket-oauth-workspace-heading">
      <div className="space-y-1">
        <h2 id="bitbucket-oauth-workspace-heading" className="type-heading">
          Choose workspace
        </h2>
        <p className="text-muted-foreground text-sm">
          Select the Bitbucket workspace this Kilo organization should use.
        </p>
      </div>
      <fieldset className="space-y-3">
        <legend className="sr-only">Bitbucket workspace</legend>
        <div className="border-border divide-border divide-y rounded-lg border">
          {availableWorkspaces.map(workspace => {
            const key = workspaceKey(workspace);
            return (
              <label
                key={key}
                className="flex min-h-control-touch cursor-pointer items-center gap-3 px-3 py-2"
              >
                <input
                  type="radio"
                  name="bitbucket-oauth-workspace"
                  value={key}
                  checked={selectedWorkspaceKey === key}
                  onChange={() => setSelectedWorkspaceKey(key)}
                  className="accent-primary size-4"
                  disabled={mutation.isPending}
                />
                <span className="min-w-0">
                  <span className="block text-sm">{workspace.name}</span>
                  <span className="text-muted-foreground block font-mono text-xs break-all">
                    {workspace.slug}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <Button
        type="button"
        className="min-h-control-touch w-full sm:h-9 sm:min-h-0 sm:w-auto"
        disabled={mutation.isPending || !selectedWorkspace}
        onClick={selectWorkspace}
      >
        {mutation.isPending ? 'Selecting workspace...' : 'Select workspace'}
      </Button>
    </section>
  );
}

export function BitbucketConnectedManagement({
  organizationId,
  status,
  statusRefetchFailed,
}: BitbucketConnectedManagementProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <BitbucketLogo className="size-5" />
              Bitbucket Cloud
            </CardTitle>
            <CardDescription>
              Organization repository access through{' '}
              {status.method === 'oauth' ? 'Bitbucket OAuth' : 'a Bitbucket Workspace Access Token'}
              .
            </CardDescription>
          </div>
          <StatusBadge status={status.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {statusRefetchFailed && (
          <Alert>
            <AlertCircle />
            <AlertTitle>Bitbucket status could not be refreshed</AlertTitle>
            <AlertDescription>
              Showing the last loaded workspace and repository cache. Try again in a minute.
            </AlertDescription>
          </Alert>
        )}
        {status.method === 'workspace_access_token' && (
          <BitbucketAdditionalPermissionsWarning scopes={status.unexpectedScopes} />
        )}
        {status.status === 'reconnect_required' && (
          <Alert className="border-status-destructive-border bg-status-destructive-surface text-status-destructive">
            <AlertCircle />
            <AlertTitle>Bitbucket access needs attention</AlertTitle>
            <AlertDescription>
              {getRecoveryGuidance(
                status.method,
                status.recoveryAction,
                status.invalidationReason,
                status.canManage
              )}
            </AlertDescription>
          </Alert>
        )}

        {status.status === 'workspace_selection_required' ? (
          <BitbucketOAuthWorkspaceSelection organizationId={organizationId} status={status} />
        ) : (
          <>
            <WorkspaceStatus status={status} />
            <BitbucketRepositoryCacheSection organizationId={organizationId} status={status} />
          </>
        )}
        {status.canManage ? (
          <BitbucketIntegrationControls organizationId={organizationId} status={status} />
        ) : (
          <Alert>
            <ShieldCheck />
            <AlertTitle>Read-only organization integration</AlertTitle>
            <AlertDescription>
              {status.method === 'oauth'
                ? status.status === 'workspace_selection_required'
                  ? 'You can view the Bitbucket connection. An organization owner or billing manager must choose a workspace before repository access is available.'
                  : 'You can view the workspace and cached repositories. An organization owner or billing manager can refresh repositories or disconnect Bitbucket.'
                : status.recoveryAction === 'disconnect_and_connect'
                  ? 'You can view the workspace and cached repositories. An organization owner or billing manager must disconnect Bitbucket, then connect the workspace again.'
                  : 'You can view the workspace and cached repositories. An organization owner or billing manager can replace the token, refresh repositories, or disconnect Bitbucket.'}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
