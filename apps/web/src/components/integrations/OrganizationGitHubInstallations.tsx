'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, Github, MoreHorizontal, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { buildGitHubInstallState } from './github-install-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirm } from '@/components/ui/confirm';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';

type OrganizationGitHubInstallationsProps = {
  organizationId: string;
};

const statusLabel = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  pending: 'Pending approval',
  suspended: 'Suspended',
  needs_attention: 'Needs attention',
} as const;

export function OrganizationGitHubInstallations({
  organizationId,
}: OrganizationGitHubInstallationsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [starting, setStarting] = useState(false);
  const searchParams = useSearchParams();
  const connectionAttemptId = searchParams.get('github_connection_attempt');
  const connectionError = searchParams.get('github_connection_error');
  const input = { organizationId };
  const { data: organization } = useOrganizationWithMembers(organizationId);
  const githubAppName =
    organization?.settings?.github_app_type === 'lite'
      ? process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite'
      : process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
  const query = useQuery(trpc.githubApps.listOrganizationInstallations.queryOptions(input));
  const { data: openRouterModels, isLoading: isLoadingModels } =
    useModelSelectorList(organizationId);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      openRouterModels?.data.map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
      })) ?? [],
    [openRouterModels]
  );
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.githubApps.listOrganizationInstallations.queryKey(input),
    });
  };
  const refresh = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: async () => {
        toast.success('GitHub access refreshed');
        await invalidate();
      },
      onError: error =>
        toast.error('Could not refresh GitHub access', { description: error.message }),
    })
  );
  const updateModel = useMutation(
    trpc.githubApps.updateModel.mutationOptions({
      onSuccess: async result => {
        if (result.success) {
          toast.success('Model updated successfully');
          await invalidate();
        } else {
          toast.error('Failed to update model', { description: result.error });
        }
      },
      onError: error => toast.error('Failed to update model', { description: error.message }),
    })
  );

  const uninstall = useMutation(
    trpc.githubApps.uninstallApp.mutationOptions({
      onSuccess: async () => {
        toast.success('GitHub App uninstalled');
        await invalidate();
      },
      onError: error =>
        toast.error('Could not uninstall GitHub App', { description: error.message }),
    })
  );

  const disconnect = useMutation(
    trpc.githubApps.disconnectConnection.mutationOptions({
      onSuccess: async () => {
        toast.success('GitHub organization disconnected from Kilo');
        await invalidate();
      },
      onError: error =>
        toast.error('Could not disconnect GitHub organization', { description: error.message }),
    })
  );
  const cancel = useMutation(
    trpc.githubApps.cancelPendingInstallation.mutationOptions({
      onSuccess: async () => {
        toast.success('Installation request removed from Kilo');
        await invalidate();
      },
      onError: error =>
        toast.error('Could not remove installation request', { description: error.message }),
    })
  );
  const mint = useMutation(trpc.githubApps.mintInstallState.mutationOptions());
  const beginConnection = useMutation(trpc.githubApps.beginConnection.mutationOptions());
  const selectConnection = useMutation(
    trpc.githubApps.selectConnectionInstallation.mutationOptions()
  );
  const connectionAttempt = useQuery({
    ...trpc.githubApps.getConnectionAttempt.queryOptions(
      connectionAttemptId
        ? { attemptId: connectionAttemptId, organizationId }
        : { attemptId: '00000000-0000-4000-8000-000000000000', organizationId }
    ),
    enabled: Boolean(connectionAttemptId),
  });

  const startInstall = async () => {
    setStarting(true);
    try {
      const result = await mint.mutateAsync({ organizationId });
      window.location.href = `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(buildGitHubInstallState(result.token))}`;
    } catch (error) {
      setStarting(false);
      toast.error('Could not open GitHub setup', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const startConnection = async () => {
    try {
      const result = await beginConnection.mutateAsync({ organizationId });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      toast.error('Could not start GitHub connection', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const confirmConnection = async (installationId: string) => {
    try {
      const result = await selectConnection.mutateAsync({
        attemptId: connectionAttemptId ?? '',
        installationId,
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      toast.error('Could not confirm GitHub connection', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  if (query.isLoading) {
    return (
      <Card className="overflow-hidden" aria-busy="true" aria-label="Loading GitHub organizations">
        <div className="px-5 py-5 sm:px-6">
          <div className="h-5 w-44 animate-pulse rounded bg-muted" />
        </div>
        <div className="border-border flex items-center gap-3 border-t px-4 py-5 sm:px-6">
          <div className="size-5 animate-pulse rounded bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </Card>
    );
  }

  const installations = query.data?.installations ?? [];
  const connectionManagementEnabled = query.data?.connectionManagementEnabled ?? false;
  return (
    <section className="min-w-0" aria-labelledby="github-organizations-heading">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <h2 id="github-organizations-heading" className="type-heading">
            GitHub organizations
          </h2>
          {(query.data?.canAdd || query.data?.canConnectExisting) && (
            <div className="flex gap-2">
              {query.data?.canConnectExisting && (
                <Button
                  variant="outline"
                  onClick={startConnection}
                  disabled={beginConnection.isPending}
                >
                  Connect existing
                </Button>
              )}
              {query.data?.canAdd && (
                <Button
                  onClick={startInstall}
                  disabled={starting}
                  className="min-h-11 w-full shrink-0 sm:min-h-0 sm:w-auto"
                >
                  <Github className="size-4" />
                  {starting
                    ? 'Opening GitHub...'
                    : installations.length
                      ? 'Add organization'
                      : 'Connect GitHub'}
                </Button>
              )}
            </div>
          )}
        </div>
        {connectionError && (
          <p className="border-border border-t px-5 py-4 text-sm text-destructive sm:px-6">
            {connectionError === 'claimed_by_other_owner'
              ? 'This GitHub installation is already connected to another Kilo account or organization. Sharing is not available yet.'
              : connectionError === 'authorization_revoked'
                ? 'GitHub ownership or Kilo administration could not be verified. Start again to reconnect.'
                : 'The GitHub connection could not be completed. Start again or install the App on GitHub.'}
          </p>
        )}
        {connectionAttemptId && (
          <div className="border-border border-t px-5 py-5 sm:px-6">
            <h3 className="font-medium">Choose a GitHub organization</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Only organizations where you are an active GitHub owner are shown.
            </p>
            {connectionAttempt.isLoading ? (
              <p className="mt-3 text-sm text-muted-foreground">Loading eligible installations…</p>
            ) : connectionAttempt.data?.candidates.length ? (
              <div className="mt-3 grid gap-2">
                {connectionAttempt.data.candidates.map(candidate => (
                  <Button
                    key={candidate.installationId}
                    variant="outline"
                    className="justify-between"
                    onClick={() => confirmConnection(candidate.installationId)}
                    disabled={selectConnection.isPending}
                  >
                    {candidate.accountLogin}
                    <span className="font-mono text-xs text-muted-foreground">
                      {candidate.installationId}
                    </span>
                  </Button>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                No eligible existing GitHub installations were found.
              </p>
            )}
          </div>
        )}
        {query.isError ? (
          <p className="border-border border-t px-5 py-6 text-sm text-destructive sm:px-6">
            Could not load GitHub organizations.
          </p>
        ) : installations.length === 0 ? (
          <p className="border-border border-t px-5 py-8 text-center text-sm text-muted-foreground sm:px-6">
            {query.data?.canAdd
              ? 'No GitHub organizations are connected yet. GitHub will let you choose an organization and repository access.'
              : 'No GitHub organizations are connected yet. Ask an organization owner or admin to connect one.'}
          </p>
        ) : (
          <div className="divide-border border-border divide-y border-t">
            {installations.map(installation => {
              const selectedCount = installation.repositories.length;
              const repositoryScope =
                installation.repositorySelection === 'all'
                  ? 'All repositories'
                  : `${selectedCount} selected ${selectedCount === 1 ? 'repository' : 'repositories'}`;
              const accountName = installation.accountLogin ?? 'GitHub organization';
              return (
                <Collapsible key={installation.id}>
                  <div className="space-y-4 px-4 py-4 sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <Github
                        className="size-5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="max-w-full truncate font-medium">{accountName}</span>
                          <Badge
                            variant={installation.status === 'connected' ? 'new' : 'secondary'}
                          >
                            {statusLabel[installation.status]}
                          </Badge>
                          {installation.isPrimary && installations.length > 1 && (
                            <Badge variant="outline">Primary</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{repositoryScope}</p>
                      </div>
                      {installation.repositorySelection === 'selected' && selectedCount > 0 && (
                        <CollapsibleTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="group min-h-11 min-w-11 shrink-0 px-0 sm:min-h-0 sm:min-w-0 sm:px-3"
                            aria-label={`Show repositories for ${accountName}`}
                          >
                            <span className="hidden sm:inline">Repositories</span>
                            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                          </Button>
                        </CollapsibleTrigger>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                            aria-label={`Manage ${accountName}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {installation.installationId && (
                            <DropdownMenuItem asChild>
                              <a
                                href={`https://github.com/apps/${githubAppName}/installations/${installation.installationId}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Manage on GitHub <ExternalLink className="ml-auto size-3.5" />
                              </a>
                            </DropdownMenuItem>
                          )}
                          {installation.canRefresh && (
                            <DropdownMenuItem
                              onSelect={() =>
                                refresh.mutate({ organizationId, integrationId: installation.id })
                              }
                            >
                              Refresh access <RefreshCw className="ml-auto size-3.5" />
                            </DropdownMenuItem>
                          )}
                          {(installation.canCancel || installation.canUninstall) && (
                            <DropdownMenuSeparator />
                          )}
                          {installation.canCancel && (
                            <DropdownMenuItem
                              onSelect={() =>
                                cancel.mutate({ organizationId, integrationId: installation.id })
                              }
                            >
                              Remove pending request
                            </DropdownMenuItem>
                          )}
                          {installation.canUninstall && installation.installationId && (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={async () => {
                                const account =
                                  installation.accountLogin ?? 'this GitHub organization';
                                if (
                                  await confirm({
                                    title: connectionManagementEnabled
                                      ? `Disconnect ${account}?`
                                      : `Uninstall Kilo from ${account}?`,
                                    description: connectionManagementEnabled
                                      ? `This disconnects ${account} from this Kilo organization. The GitHub App stays installed and can be reconnected after fresh verification.`
                                      : `This uninstalls the Kilo GitHub App from ${account}. Kilo will lose access to its repositories.`,
                                    confirmLabel: connectionManagementEnabled
                                      ? `Disconnect ${account}`
                                      : `Uninstall from ${account}`,
                                    destructive: true,
                                  })
                                ) {
                                  if (connectionManagementEnabled) {
                                    disconnect.mutate({
                                      organizationId,
                                      integrationId: installation.id,
                                    });
                                  } else {
                                    uninstall.mutate({
                                      organizationId,
                                      integrationId: installation.id,
                                    });
                                  }
                                }
                              }}
                            >
                              {connectionManagementEnabled
                                ? 'Disconnect from Kilo'
                                : 'Uninstall GitHub App'}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {installation.status === 'connected' && (
                      <div className="space-y-3 rounded-lg border p-4">
                        <ModelCombobox
                          id={`model-combobox-${installation.id}`}
                          label="AI Model"
                          helperText="Select the AI model to use when responding to GitHub bot mentions"
                          models={modelOptions}
                          value={installation.modelSlug ?? undefined}
                          onValueChange={modelSlug =>
                            updateModel.mutate({
                              organizationId,
                              integrationId: installation.id,
                              modelSlug,
                            })
                          }
                          isLoading={isLoadingModels}
                          disabled={!installation.canManageModel}
                          placeholder="Select a model"
                          triggerAriaLabel={`AI model for ${accountName}`}
                        />
                      </div>
                    )}
                  </div>
                  {installation.repositorySelection === 'selected' && (
                    <CollapsibleContent>
                      <div className="border-border bg-muted/30 border-t px-4 py-3 sm:px-5">
                        <ul className="grid gap-1 sm:grid-cols-2">
                          {installation.repositories.map(repository => (
                            <li
                              key={repository.id}
                              className="truncate font-mono text-xs text-muted-foreground"
                            >
                              {repository.full_name}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}
