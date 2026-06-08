'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationWithMembers } from '@/lib/organizations/organization-types';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';
import { ConnectToKiloDialog } from './ConnectToKiloDialog';
import { CopyButton } from './CopyButton';
import { OrgMemberPicker } from './OrgMemberPicker';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, CheckCircle2, Cable, RotateCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

type McpGatewayDetailContentProps = {
  configId: string;
  organizationId?: string;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
      return 'Automatic provider sign-in';
    case 'oauth_static':
      return 'Manual provider credentials';
    default:
      return authMode;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/20 rounded-lg border px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

export function McpGatewayDetailContent({
  configId,
  organizationId,
}: McpGatewayDetailContentProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const routes = getMcpGatewayRoutes(organizationId);
  const managedConfigInput = { configId, organizationId };
  const [staticHeaderName, setStaticHeaderName] = useState('Authorization');
  const [staticHeaderValue, setStaticHeaderValue] = useState('');
  const [providerClientId, setProviderClientId] = useState('');
  const [providerClientSecret, setProviderClientSecret] = useState('');
  const [providerScopes, setProviderScopes] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const detailQuery = useQuery(
    organizationId
      ? trpc.mcpGateway.getOrganization.queryOptions({ organizationId, configId })
      : trpc.mcpGateway.getPersonal.queryOptions({ configId })
  );
  const membersQuery = useQuery<OrganizationWithMembers>({
    queryKey: organizationId
      ? trpc.organizations.withMembers.queryKey({ organizationId })
      : [['organizations', 'withMembers', 'disabled']],
    queryFn: async () => {
      if (!organizationId) {
        throw new Error('Organization ID is required');
      }
      return await queryClient.fetchQuery(
        trpc.organizations.withMembers.queryOptions({ organizationId })
      );
    },
    enabled: Boolean(organizationId),
  });
  const excludedUserIds = useMemo(
    () => detailQuery.data?.assignments.map(assignment => assignment.userId) ?? [],
    [detailQuery.data?.assignments]
  );
  const memberById = useMemo(() => {
    const map = new Map<string, { name: string; email: string }>();
    for (const member of membersQuery.data?.members ?? []) {
      if (member.status === 'active') {
        map.set(member.id, { name: member.name, email: member.email });
      }
    }
    return map;
  }, [membersQuery.data]);
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
        setRotateDialogOpen(false);
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not rotate the connect URL'),
    })
  );
  const disableMutation = useMutation(
    trpc.mcpGateway.disable.mutationOptions({
      onSuccess: () => {
        toast.success('Connection disabled');
        setDisableDialogOpen(false);
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not disable the connection'),
    })
  );
  const deleteMutation = useMutation(
    trpc.mcpGateway.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Connection deleted');
        setDeleteDialogOpen(false);
        router.push(routes.list);
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
  const providerScopesMutation = useMutation(
    trpc.mcpGateway.updateProviderScopes.mutationOptions({
      onSuccess: () => {
        toast.success('Provider scopes saved');
        refresh();
      },
      onError: error => toast.error(error.message || 'Could not save provider scopes'),
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

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Card>
          <CardHeader className="pb-4">
            <Skeleton className="h-5 w-28" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
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
  const needsSignIn = requiresProviderSignIn(connection.authMode);
  const signedIn = connection.activeGrantCount > 0;
  const managesCredentials =
    connection.authMode === 'static_headers' || connection.authMode === 'oauth_static';
  const missingStaticCredentials =
    connection.authMode === 'oauth_static' && !connection.hasStaticProviderCredentials;
  const suggestedName = slugify(connection.name) || 'kilo-gateway';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="space-y-1.5">
        <Link
          href={routes.list}
          className="text-muted-foreground inline-flex items-center gap-2 text-sm hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to connections
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
          <ConnectionStatusBadge connection={connection} />
        </div>
        <p className="text-muted-foreground font-mono text-xs break-all">{connection.remoteUrl}</p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Overview</CardTitle>
          <CardDescription>Endpoint, auth, and current connection state.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Field label="Remote MCP URL">
              <span className="font-mono text-xs break-all">{connection.remoteUrl}</span>
            </Field>
            <Field label="Access">
              {organizationId ? 'Assigned organization members' : 'Personal owner'}
            </Field>
            <Field label="Provider sign-in">{authLabel(connection.authMode)}</Field>
            {connection.providerScopes && (
              <Field label="Provider scopes">
                <span className="font-mono text-xs">{connection.providerScopes.join(' ')}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {connection.providerScopeSource === 'override' ? 'Admin override' : 'Discovered'}
                </span>
              </Field>
            )}
            {connection.providerResource && (
              <Field label="Provider resource">
                <span className="font-mono text-xs break-all">{connection.providerResource}</span>
              </Field>
            )}
            <Field label="Descendant paths">
              {connection.pathPassthrough ? 'Allowed' : 'Exact endpoint only'}
            </Field>
          </dl>
          <div className="grid gap-3 border-t pt-5 sm:grid-cols-2 lg:grid-cols-3">
            {organizationId && <Stat label="Assigned users" value={connection.assignmentCount} />}
            <Stat label="Active instances" value={connection.instanceCount} />
            <Stat label="Provider grants" value={connection.activeGrantCount} />
          </div>
        </CardContent>
      </Card>

      {organizationId && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Access</CardTitle>
            <CardDescription>Assign each member who can use this connection.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-3xl space-y-5">
              <div className="space-y-2">
                <Label htmlFor="assign-user">Assign a member</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {organizationId && (
                    <OrgMemberPicker
                      id="assign-user"
                      organizationId={organizationId}
                      value={assignedUserId}
                      onValueChange={setAssignedUserId}
                      excludeUserIds={excludedUserIds}
                    />
                  )}
                  <Button
                    variant="outline"
                    onClick={() =>
                      assignMutation.mutate({ ...managedConfigInput, userId: assignedUserId })
                    }
                    disabled={!assignedUserId || assignMutation.isPending}
                  >
                    {assignMutation.isPending ? 'Assigning...' : 'Assign member'}
                  </Button>
                </div>
              </div>
              {connection.assignments.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">
                    Assigned members ({connection.assignments.length})
                  </p>
                  <div className="border-border divide-y rounded-md border">
                    {connection.assignments.map(assignment => {
                      const member = memberById.get(assignment.userId);
                      return (
                        <div
                          key={assignment.assignmentId}
                          className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="truncate">
                              {member?.name || member?.email || 'Unknown member'}
                            </div>
                            <div className="text-muted-foreground truncate text-xs">
                              {member?.name ? member.email : assignment.userId}
                            </div>
                          </div>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground hover:text-foreground sm:-mr-2"
                                disabled={revokeAssignmentMutation.isPending}
                              >
                                Revoke access
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Revoke member access?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This removes the member's assignment, active instance, and
                                  provider grant for this connection.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() =>
                                    revokeAssignmentMutation.mutate({
                                      ...managedConfigInput,
                                      userId: assignment.userId,
                                    })
                                  }
                                >
                                  Revoke access
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No members assigned yet.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {needsSignIn && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Provider sign-in</CardTitle>
            <CardDescription>
              {organizationId
                ? 'Assigned users sign in with their own provider account.'
                : 'Sign in so Kilo Code can call this server on your behalf.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3">
              {signedIn ? (
                <div className="flex max-w-2xl items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-4">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-400" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {organizationId ? 'Provider sign-in active' : "You're signed in"}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {organizationId
                        ? connection.activeGrantCount === 1
                          ? '1 assigned user has an active provider grant.'
                          : `${connection.activeGrantCount} assigned users have active provider grants.`
                        : 'Kilo Code can reach this server now.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex max-w-2xl items-start gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
                  <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-yellow-400" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Not signed in yet</p>
                    <p className="text-muted-foreground text-sm">
                      {organizationId
                        ? 'Assigned users complete sign-in when they first use this connection.'
                        : 'Sign in to start using this connection.'}
                    </p>
                  </div>
                </div>
              )}
              {missingStaticCredentials && (
                <p className="text-xs text-yellow-400">
                  Add provider credentials in the Credentials section below before signing in.
                </p>
              )}
              {!organizationId && (
                <Button
                  onClick={() => providerSignInMutation.mutate(managedConfigInput)}
                  disabled={providerSignInMutation.isPending || missingStaticCredentials}
                >
                  {providerSignInMutation.isPending
                    ? 'Starting...'
                    : signedIn
                      ? 'Re-authenticate'
                      : 'Start provider sign-in'}
                </Button>
              )}
            </div>
            <div className="max-w-lg space-y-3 border-t pt-5">
              <div className="space-y-1.5">
                <Label htmlFor="provider-scopes">Provider scopes</Label>
                <p className="text-muted-foreground text-xs">
                  Optional upstream provider scopes. Leave blank and save to clear an override.
                </p>
              </div>
              <Input
                id="provider-scopes"
                value={providerScopes}
                onChange={event => setProviderScopes(event.target.value)}
                placeholder={connection.providerScopes?.join(' ') || 'No provider scopes'}
              />
              <Button
                variant="outline"
                onClick={() =>
                  providerScopesMutation.mutate({
                    ...managedConfigInput,
                    providerScopes: providerScopes.trim()
                      ? providerScopes.trim().split(/\s+/)
                      : null,
                  })
                }
                disabled={providerScopesMutation.isPending}
              >
                {providerScopesMutation.isPending ? 'Saving...' : 'Save provider scopes'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {managesCredentials && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Credentials</CardTitle>
            <CardDescription>Stored secrets are not shown again after saving.</CardDescription>
          </CardHeader>
          <CardContent>
            {connection.authMode === 'static_headers' && (
              <div className="max-w-lg space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="static-header-name">Header name</Label>
                  <Input
                    id="static-header-name"
                    value={staticHeaderName}
                    onChange={event => setStaticHeaderName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="static-header-value">Header value</Label>
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
                  {staticHeadersMutation.isPending ? 'Saving...' : 'Save static header'}
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
                  {staticProviderMutation.isPending ? 'Saving...' : 'Save provider credentials'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Connect URL</CardTitle>
          <CardDescription>Point Kilo Code at this URL.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/70 flex min-w-0 items-center gap-2 rounded-md px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs" title={connection.canonicalUrl}>
              {connection.canonicalUrl}
            </code>
            <CopyButton
              value={connection.canonicalUrl}
              ariaLabel="Copy connect URL"
              toastLabel="Connect URL copied"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button onClick={() => setConnectDialogOpen(true)}>
              <Cable className="size-4" />
              Connect to Kilo
            </Button>
            <AlertDialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" disabled={rotateMutation.isPending}>
                  <RotateCw className="size-4" />
                  Rotate URL
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate this connect URL?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The current URL and any gateway tokens bound to it stop working immediately.
                    Provider sign-in grants remain available on the new URL.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={rotateMutation.isPending}>
                    Keep current URL
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => rotateMutation.mutate(managedConfigInput)}
                    disabled={rotateMutation.isPending}
                  >
                    Rotate URL
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <ConnectToKiloDialog
            open={connectDialogOpen}
            onOpenChange={setConnectDialogOpen}
            connectUrl={connection.canonicalUrl}
            suggestedName={suggestedName}
          />
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader className="pb-4">
          <CardTitle className="text-destructive text-base">Danger zone</CardTitle>
          <CardDescription>These actions take effect immediately.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <AlertDialog open={disableDialogOpen} onOpenChange={setDisableDialogOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={!connection.enabled || disableMutation.isPending}
                >
                  <ShieldAlert className="size-4" />
                  Disable connection
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disable this connection?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Requests through this connection will be blocked immediately after this action.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={disableMutation.isPending}>
                    Keep connection
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => disableMutation.mutate(managedConfigInput)}
                    disabled={disableMutation.isPending}
                  >
                    Disable connection
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={deleteMutation.isPending}>
                  <Trash2 className="size-4" />
                  Delete connection
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this connection?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently invalidates its connect URL and revokes dependent instances,
                    provider grants, and pending provider sign-ins.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>
                    Keep connection
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => deleteMutation.mutate(managedConfigInput)}
                    disabled={deleteMutation.isPending}
                  >
                    Delete connection
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
