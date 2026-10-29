'use client';

import { useState } from 'react';
import {
  Boxes,
  GitBranch,
  Hammer,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  useEnvironmentRepositoryChoices,
  type EnvironmentRepositoryChoice,
} from '@/hooks/useEnvironmentRepositoryChoices';
import {
  environmentMembers,
  useCloudAgentEnvironmentMutations,
  useCloudAgentEnvironmentsForOwner,
  useMultiRepositoryEnvironmentsEnabled,
  useEnvironmentBuildStatus,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
import { findRepositoryEnvironments, formatEnvironmentCounts } from '../environment-display';
import { EnvironmentDialog } from '../EnvironmentDialog';
import { useEnvironmentBuildControl } from '../EnvironmentBuildPanel';
import { buildAction, snapshotBadge } from '../environment-build-display';

type EnvironmentsSectionProps = {
  organizationId?: string;
  canManage: boolean;
};

export function EnvironmentsSection({ organizationId, canManage }: EnvironmentsSectionProps) {
  const query = useCloudAgentEnvironmentsForOwner({ organizationId });
  const { deleteEnvironment } = useCloudAgentEnvironmentMutations();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogEnvironmentId, setDialogEnvironmentId] = useState<string | null>(null);
  const [dialogRepository, setDialogRepository] = useState<EnvironmentRepository | undefined>();
  const [pendingDelete, setPendingDelete] = useState<EnvironmentSummary | null>(null);

  const repoChoices = useEnvironmentRepositoryChoices(organizationId);
  const { enabled: multiRepositoryEnabled } = useMultiRepositoryEnvironmentsEnabled(organizationId);

  const environments = query.data ?? [];

  const openCreate = (choice: EnvironmentRepositoryChoice) => {
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
            Setup commands, variables, secrets, and a sandbox size for a repository
            {multiRepositoryEnabled ? ' or a group of repositories' : ''}. New sessions use the
            environment that contains their repository. When several do, you choose one.
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
                          // A single-repository environment is the repository's only one, so
                          // choosing it again edits it. With multi-repository environments on,
                          // choosing a repository starts a new environment.
                          const existing = multiRepositoryEnabled
                            ? undefined
                            : findRepositoryEnvironments(environments, choice.repository).find(
                                environment => environment.repositories === undefined
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
              organizationId={organizationId}
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
        canManage={canManage}
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
  organizationId,
  canManage,
  onEdit,
  onDelete,
}: {
  environment: EnvironmentSummary;
  organizationId?: string;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = formatEnvironmentCounts(environment);
  const { data: buildStatus } = useEnvironmentBuildStatus(environment.id, { organizationId });
  const badge = snapshotBadge(buildStatus, Date.now());
  const members = environmentMembers(environment);
  const primary = members[0];
  const repositoryList = members.map(member => member.repoFullName).join(', ');
  return (
    <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
      <Boxes className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium" title={environment.name}>
            {environment.name}
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {platformLabel(primary?.platform ?? 'github')}
          </Badge>
          {members.length > 1 && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {members.length} repos
            </Badge>
          )}
          {badge && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {badge}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs" title={repositoryList}>
          {repositoryList}
        </p>
        {meta && <p className="text-muted-foreground text-xs">{meta}</p>}
      </div>
      {canManage && (
        <EnvironmentRowMenu
          environment={environment}
          organizationId={organizationId}
          buildStatus={buildStatus}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function EnvironmentRowMenu({
  environment,
  organizationId,
  buildStatus,
  onEdit,
  onDelete,
}: {
  environment: EnvironmentSummary;
  organizationId?: string;
  buildStatus: ReturnType<typeof useEnvironmentBuildStatus>['data'];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const control = useEnvironmentBuildControl({
    organizationId,
    environmentId: environment.id,
    status: buildStatus,
  });
  const action = buildAction(buildStatus, { canManage: true, hasUnsavedChanges: false });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground h-7 w-7 shrink-0"
          title={`Actions for ${environment.name}`}
          aria-label={`Actions for ${environment.name}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </DropdownMenuItem>
        {(action.kind === 'build' || action.kind === 'refresh') && (
          <DropdownMenuItem disabled={control.isPending} onSelect={() => void control.start()}>
            {action.kind === 'refresh' ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Hammer className="h-3.5 w-3.5" />
            )}
            {action.kind === 'refresh' ? 'Refresh snapshot' : 'Build snapshot'}
          </DropdownMenuItem>
        )}
        {action.kind === 'cancel' && (
          <DropdownMenuItem
            disabled={control.isPending}
            onSelect={() => control.cancel(action.buildId)}
          >
            <Square className="h-3.5 w-3.5" />
            Cancel build
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function repositoryLabel(repository: EnvironmentRepository): string {
  return repository.platform === 'gitlab' ? repository.projectPath : repository.fullName;
}

function platformLabel(platform: 'github' | 'gitlab' | 'bitbucket'): string {
  return platform === 'gitlab' ? 'GL' : platform === 'bitbucket' ? 'BB' : 'GH';
}
