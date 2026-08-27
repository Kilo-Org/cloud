'use client';

import { useState } from 'react';
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

type OrganizationGitHubInstallationsProps = {
  organizationId: string;
};

const statusLabel = {
  connected: 'Connected',
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
  const input = { organizationId };
  const { data: organization } = useOrganizationWithMembers(organizationId);
  const githubAppName =
    organization?.settings?.github_app_type === 'lite'
      ? process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite'
      : process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
  const query = useQuery(trpc.githubApps.listOrganizationInstallations.queryOptions(input));
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
  const uninstall = useMutation(
    trpc.githubApps.uninstallApp.mutationOptions({
      onSuccess: async () => {
        toast.success('GitHub organization disconnected');
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
  return (
    <section className="min-w-0" aria-labelledby="github-organizations-heading">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <h2 id="github-organizations-heading" className="type-heading">
            GitHub organizations
          </h2>
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
                <Collapsible
                  key={installation.id}
                  id={`github-installation-${installation.id}`}
                  className="scroll-mt-6"
                >
                  <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:px-5">
                    <Github className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="max-w-full truncate font-medium">{accountName}</span>
                        <Badge variant={installation.status === 'connected' ? 'new' : 'secondary'}>
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
                                  title: `Disconnect ${account}?`,
                                  description: `This uninstalls the Kilo GitHub App from ${account}. Kilo will lose access to its repositories.`,
                                  confirmLabel: `Disconnect ${account}`,
                                  destructive: true,
                                })
                              ) {
                                uninstall.mutate({
                                  organizationId,
                                  integrationId: installation.id,
                                });
                              }
                            }}
                          >
                            Disconnect organization
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
