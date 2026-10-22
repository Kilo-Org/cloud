'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, GitBranch, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useTRPC } from '@/lib/trpc/utils';
import {
  useCloudAgentEnvironmentMutations,
  useCloudAgentEnvironmentsForOwner,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
import { findRepositoryEnvironment, formatEnvironmentCounts } from '../environment-display';
import { EnvironmentDialog } from '../EnvironmentDialog';

type EnvironmentsSectionProps = {
  organizationId?: string;
  canManage: boolean;
};

type RepoChoice = {
  platform: 'github' | 'gitlab' | 'bitbucket';
  label: string;
  repository: EnvironmentRepository;
};

export function EnvironmentsSection({ organizationId, canManage }: EnvironmentsSectionProps) {
  const trpc = useTRPC();
  const query = useCloudAgentEnvironmentsForOwner({ organizationId });
  const { deleteEnvironment } = useCloudAgentEnvironmentMutations();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogEnvironmentId, setDialogEnvironmentId] = useState<string | null>(null);
  const [dialogRepository, setDialogRepository] = useState<EnvironmentRepository | undefined>();
  const [pendingDelete, setPendingDelete] = useState<EnvironmentSummary | null>(null);

  const { data: githubRepoData } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })
  );
  const { data: gitlabRepoData } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })
  );
  const { data: bitbucketRepoData } = useQuery({
    ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
      organizationId: organizationId ?? '',
      forceRefresh: false,
    }),
    enabled: !!organizationId,
  });

  const repoChoices = useMemo<RepoChoice[]>(() => {
    const github = (githubRepoData?.repositories ?? []).map(repo => ({
      platform: 'github' as const,
      label: repo.fullName,
      repository: { platform: 'github' as const, fullName: repo.fullName },
    }));
    const gitlab = (gitlabRepoData?.repositories ?? []).map(repo => ({
      platform: 'gitlab' as const,
      label: repo.fullName,
      repository: { platform: 'gitlab' as const, projectPath: repo.fullName },
    }));
    const bitbucket = (
      bitbucketRepoData?.status === 'available' ? bitbucketRepoData.repositories : []
    ).map(repo => ({
      platform: 'bitbucket' as const,
      label: repo.fullName,
      repository: {
        platform: 'bitbucket' as const,
        fullName: repo.fullName,
        workspaceUuid: repo.workspaceUuid,
        repositoryUuid: String(repo.id),
      },
    }));
    return [...github, ...gitlab, ...bitbucket];
  }, [githubRepoData, gitlabRepoData, bitbucketRepoData]);

  const environments = query.data ?? [];

  const openCreate = (choice: RepoChoice) => {
    setDialogEnvironmentId(null);
    setDialogRepository(choice.repository);
    setPickerOpen(false);
    setDialogOpen(true);
  };

  const openEdit = (environmentId: string) => {
    setDialogEnvironmentId(environmentId);
    setDialogRepository(undefined);
    setPickerOpen(false);
    setDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteEnvironment.mutateAsync({ organizationId, environmentId: pendingDelete.id });
      toast.success(`Environment "${pendingDelete.name}" deleted`);
      setPendingDelete(null);
    } catch {
      toast.error('Failed to delete environment');
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environments</h3>
          <p className="text-muted-foreground text-xs">
            Saved repository setup, applied to new sessions automatically.
          </p>
        </div>
        {canManage && (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0">
                <Plus className="mr-1.5 h-4 w-4" />
                Add environment
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-0" align="end">
              <Command>
                <CommandInput placeholder="Search repositories..." />
                <CommandEmpty>No repositories match your search</CommandEmpty>
                <CommandList className="max-h-64 overflow-auto">
                  {(['github', 'gitlab', 'bitbucket'] as const).map(platform => {
                    const choices = repoChoices.filter(choice => choice.platform === platform);
                    if (choices.length === 0) return null;
                    return (
                      <CommandGroup
                        key={platform}
                        heading={
                          platform === 'github'
                            ? 'GitHub'
                            : platform === 'gitlab'
                              ? 'GitLab'
                              : 'Bitbucket'
                        }
                      >
                        {choices.map(choice => {
                          // A repository has one environment, so choosing it again edits it.
                          const existing = findRepositoryEnvironment(
                            environments,
                            choice.repository
                          );
                          return (
                            <CommandItem
                              key={`${platform}:${choice.label}`}
                              value={`${platform}:${choice.label}`}
                              onSelect={() =>
                                existing ? openEdit(existing.id) : openCreate(choice)
                              }
                              className="flex items-center gap-2"
                            >
                              <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
                              <span className="flex-1 truncate" title={choice.label}>
                                {choice.label}
                              </span>
                              {existing && (
                                <span className="text-muted-foreground shrink-0 text-xs">Edit</span>
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : query.isError ? (
        <div className="space-y-3 py-8 text-center">
          <p className="text-destructive text-sm">Failed to load environments.</p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : environments.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">No environments</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Add one to give a repository setup commands, variables, secrets, and a sandbox size.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {environments.map(environment => (
            <EnvironmentRow
              key={environment.id}
              environment={environment}
              canManage={canManage}
              onEdit={() => openEdit(environment.id)}
              onDelete={() => setPendingDelete(environment)}
            />
          ))}
        </div>
      )}

      <EnvironmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        repository={dialogRepository}
        repositoryLabel={dialogRepository ? repositoryLabel(dialogRepository) : undefined}
        environmentId={dialogEnvironmentId}
        onSaved={() => setDialogOpen(false)}
        onDeleted={() => setDialogOpen(false)}
      />

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={isOpen => {
          if (!isOpen) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently removes &quot;{pendingDelete?.name}&quot; and its commands, variables, and
              secrets. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteEnvironment.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteEnvironment.isPending}
              onClick={() => void confirmDelete()}
            >
              Delete environment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function EnvironmentRow({
  environment,
  canManage,
  onEdit,
  onDelete,
}: {
  environment: EnvironmentSummary;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = formatEnvironmentCounts(environment);
  return (
    <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
      <Boxes className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium" title={environment.name}>
            {environment.name}
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {platformLabel(environment.platform)}
          </Badge>
        </div>
        <p className="text-muted-foreground truncate text-xs" title={environment.repoFullName}>
          {environment.repoFullName}
        </p>
        {meta && <p className="text-muted-foreground text-xs">{meta}</p>}
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground h-7 w-7"
            title={`Edit ${environment.name}`}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive h-7 w-7"
            title={`Delete ${environment.name}`}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

function repositoryLabel(repository: EnvironmentRepository): string {
  return repository.platform === 'gitlab' ? repository.projectPath : repository.fullName;
}

function platformLabel(platform: EnvironmentSummary['platform']): string {
  return platform === 'gitlab' ? 'GL' : platform === 'bitbucket' ? 'BB' : 'GH';
}
