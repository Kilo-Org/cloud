'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { ArrowLeft, Copy, RotateCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type McpGatewayDetailContentProps = {
  configId: string;
  organizationId?: string;
};

function requiresProviderSignIn(authMode: string) {
  return authMode === 'oauth_dynamic' || authMode === 'oauth_static';
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

export function McpGatewayDetailContent({
  configId,
  organizationId,
}: McpGatewayDetailContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routes = getMcpGatewayRoutes(organizationId);
  const managedConfigInput = { configId, organizationId };
  const [staticHeaderName, setStaticHeaderName] = useState('Authorization');
  const [staticHeaderValue, setStaticHeaderValue] = useState('');
  const [providerClientId, setProviderClientId] = useState('');
  const [providerClientSecret, setProviderClientSecret] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');
  const detailQuery = useQuery(
    organizationId
      ? trpc.mcpGateway.getOrganization.queryOptions({ organizationId, configId })
      : trpc.mcpGateway.getPersonal.queryOptions({ configId })
  );
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: organizationId
        ? trpc.mcpGateway.getOrganization.queryKey({ organizationId, configId })
        : trpc.mcpGateway.getPersonal.queryKey({ configId }),
    });
    void queryClient.invalidateQueries({
      queryKey: organizationId
        ? trpc.mcpGateway.listOrganization.queryKey({ organizationId })
        : trpc.mcpGateway.listPersonal.queryKey(),
    });
  };
  const rotateMutation = useMutation(
    trpc.mcpGateway.rotateRoute.mutationOptions({
      onSuccess: () => {
        toast.success('Connect URL rotated');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not rotate the connect URL'),
    })
  );
  const disableMutation = useMutation(
    trpc.mcpGateway.disable.mutationOptions({
      onSuccess: () => {
        toast.success('Connection disabled');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not disable the connection'),
    })
  );
  const deleteMutation = useMutation(
    trpc.mcpGateway.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Connection deleted');
        window.location.assign(routes.list);
      },
      onError: error => toast.error(error.message || 'Could not delete the connection'),
    })
  );
  const staticHeadersMutation = useMutation(
    trpc.mcpGateway.upsertStaticHeaders.mutationOptions({
      onSuccess: () => {
        toast.success('Static headers saved');
        setStaticHeaderValue('');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not save static headers'),
    })
  );
  const assignMutation = useMutation(
    trpc.mcpGateway.assignUser.mutationOptions({
      onSuccess: () => {
        toast.success('User assigned');
        setAssignedUserId('');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not assign the user'),
    })
  );
  const revokeAssignmentMutation = useMutation(
    trpc.mcpGateway.revokeAssignment.mutationOptions({
      onSuccess: () => {
        toast.success('User access revoked');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not revoke user access'),
    })
  );
  const providerSignInMutation = useMutation(
    trpc.mcpGateway.startProviderSignIn.mutationOptions({
      onSuccess: data => {
        window.location.assign(data.authorizationUrl);
      },
      onError: error => toast.error(error.message || 'Could not start provider sign-in'),
    })
  );
  const staticProviderMutation = useMutation(
    trpc.mcpGateway.upsertStaticProviderCredentials.mutationOptions({
      onSuccess: () => {
        toast.success('Provider credentials saved');
        setProviderClientSecret('');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not save provider credentials'),
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

  if (detailQuery.isLoading) {
    return <div className="p-6 text-sm">Loading connection…</div>;
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="space-y-3 p-6 text-sm" role="alert">
        <p>We couldn't load this connection. Try again.</p>
        <Button variant="outline" onClick={() => detailQuery.refetch()}>
          Retry loading connection
        </Button>
      </div>
    );
  }
  const connection = detailQuery.data;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Link
          href={routes.list}
          className="text-muted-foreground inline-flex items-center gap-2 text-sm hover:text-foreground"
        >
          <ArrowLeft />
          Back to connections
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
          <Badge variant={connection.enabled ? 'secondary' : 'outline'}>
            {connection.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">{connection.remoteUrl}</p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Connection</CardTitle>
          <CardDescription>Current connection definition and runtime status.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3 border-b pb-6">
            <h2 className="text-sm font-medium">Connection</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Remote MCP URL</dt>
                <dd className="font-mono text-xs break-all">{connection.remoteUrl}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Sharing mode</dt>
                <dd>
                  {connection.sharingMode === 'single_user' ? 'Single user' : 'Shared endpoint'}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Provider sign-in</dt>
                <dd>{authLabel(connection.authMode)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Path passthrough</dt>
                <dd>{connection.pathPassthrough ? 'Allowed' : 'Disabled'}</dd>
              </div>
            </dl>
          </section>

          <section className="space-y-3 border-b pb-6">
            <h2 className="text-sm font-medium">Access</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              {organizationId && (
                <div className="space-y-1">
                  <dt className="text-muted-foreground text-xs">Assigned users</dt>
                  <dd className="tabular-nums">{connection.assignmentCount}</dd>
                </div>
              )}
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Active instances</dt>
                <dd className="tabular-nums">{connection.instanceCount}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground text-xs">Provider grants</dt>
                <dd className="tabular-nums">{connection.activeGrantCount}</dd>
              </div>
            </dl>
            {!organizationId && (
              <p className="text-muted-foreground text-sm">
                Personal connections are available only in your personal context.
              </p>
            )}
            {organizationId && (
              <>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={assignedUserId}
                    onChange={event => setAssignedUserId(event.target.value)}
                    placeholder="User ID"
                    aria-label="Assign user ID"
                    className="sm:max-w-xs"
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      assignMutation.mutate({ ...managedConfigInput, userId: assignedUserId })
                    }
                    disabled={!assignedUserId || assignMutation.isPending}
                  >
                    Assign user
                  </Button>
                </div>
                {connection.assignments.length > 0 && (
                  <div className="border-border mt-3 divide-y rounded-md border">
                    {connection.assignments.map(assignment => (
                      <div
                        key={assignment.assignmentId}
                        className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span className="min-w-0 break-all font-mono text-xs">
                          {assignment.userId}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            revokeAssignmentMutation.mutate({
                              ...managedConfigInput,
                              userId: assignment.userId,
                            })
                          }
                          disabled={revokeAssignmentMutation.isPending}
                        >
                          Revoke access
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="space-y-3 border-b pb-6">
            <h2 className="text-sm font-medium">Provider sign-in</h2>
            {!requiresProviderSignIn(connection.authMode) && (
              <p className="text-muted-foreground text-sm">
                This connection does not require provider sign-in.
              </p>
            )}
            {requiresProviderSignIn(connection.authMode) && (
              <>
                <p className="text-muted-foreground text-sm">
                  {connection.activeGrantCount > 0
                    ? 'At least one assigned user has an active provider sign-in.'
                    : organizationId
                      ? 'Assigned users complete provider sign-in when they start using this connection.'
                      : 'No active provider sign-in yet. Start sign-in before using this connection.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {!organizationId && (
                    <Button
                      variant="outline"
                      onClick={() => providerSignInMutation.mutate(managedConfigInput)}
                      disabled={providerSignInMutation.isPending}
                    >
                      Start provider sign-in
                    </Button>
                  )}
                  <Badge variant={connection.hasDynamicRegistration ? 'secondary' : 'outline'}>
                    {connection.hasDynamicRegistration
                      ? 'Automatic provider sign-in available'
                      : 'Automatic provider sign-in not available'}
                  </Badge>
                  <Badge
                    variant={connection.hasStaticProviderCredentials ? 'secondary' : 'outline'}
                  >
                    {connection.hasStaticProviderCredentials
                      ? 'Manual provider credentials saved'
                      : 'Manual provider credentials not saved'}
                  </Badge>
                </div>
              </>
            )}
          </section>

          <section className="space-y-3 border-b pb-6">
            <h2 className="text-sm font-medium">Credentials</h2>
            <p className="text-muted-foreground text-sm">
              Stored secrets are not shown again after saving.
            </p>
            {connection.authMode === 'static_headers' && (
              <div className="max-w-lg space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="static-header-name">Static header name</Label>
                  <Input
                    id="static-header-name"
                    value={staticHeaderName}
                    onChange={event => setStaticHeaderName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="static-header-value">Static header value</Label>
                  <SecretTokenInput
                    id="static-header-value"
                    value={staticHeaderValue}
                    onChange={event => setStaticHeaderValue(event.target.value)}
                    placeholder="Secret value"
                    toggleLabel="Show static header value"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() =>
                    staticHeadersMutation.mutate({
                      ...managedConfigInput,
                      headers: { [staticHeaderName]: staticHeaderValue },
                    })
                  }
                  disabled={
                    !staticHeaderName || !staticHeaderValue || staticHeadersMutation.isPending
                  }
                >
                  Save static header
                </Button>
              </div>
            )}
            {connection.authMode === 'oauth_static' && (
              <div className="max-w-lg space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="provider-client-id">Provider client ID</Label>
                  <SecretTokenInput
                    id="provider-client-id"
                    value={providerClientId}
                    onChange={event => setProviderClientId(event.target.value)}
                    toggleLabel="Show provider client ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-client-secret">Provider client secret</Label>
                  <SecretTokenInput
                    id="provider-client-secret"
                    value={providerClientSecret}
                    onChange={event => setProviderClientSecret(event.target.value)}
                    placeholder="Secret value"
                    toggleLabel="Show provider client secret"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() =>
                    staticProviderMutation.mutate({
                      ...managedConfigInput,
                      clientId: providerClientId,
                      clientSecret: providerClientSecret,
                    })
                  }
                  disabled={
                    !providerClientId || !providerClientSecret || staticProviderMutation.isPending
                  }
                >
                  Save provider credentials
                </Button>
              </div>
            )}
            {(connection.authMode === 'none' || connection.authMode === 'oauth_dynamic') && (
              <p className="text-muted-foreground text-sm">
                This connection does not use manually managed credentials.
              </p>
            )}
          </section>

          <section className="space-y-3 border-b pb-6">
            <h2 className="text-sm font-medium">Connect URL</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <code className="bg-muted rounded-md px-3 py-2 text-xs break-all flex-1">
                {connection.canonicalUrl}
              </code>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => copyConnectUrl(connection.canonicalUrl)}>
                  <Copy />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  onClick={() => rotateMutation.mutate(managedConfigInput)}
                  disabled={rotateMutation.isPending}
                >
                  <RotateCw />
                  Rotate URL
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Rotating the route key invalidates the old connect URL immediately.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-destructive">Danger zone</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => disableMutation.mutate(managedConfigInput)}
                disabled={!connection.enabled || disableMutation.isPending}
              >
                <ShieldAlert />
                Disable connection
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(managedConfigInput)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 />
                Delete connection
              </Button>
            </div>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
