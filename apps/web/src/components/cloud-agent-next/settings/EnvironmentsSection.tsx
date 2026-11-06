'use client';

import { useState } from 'react';
import { Boxes, GitBranch, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  useCloudAgentEnvironmentsForOwner,
  useEnvironmentBuildStatus,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
import {
  isOpenEnvironmentSetupRun,
  useEnvironmentSetupEnabled,
  useEnvironmentSetupRunsForEnvironment,
} from '@/hooks/useEnvironmentSetupRuns';
import { EnvironmentSetupAgentDialog } from '../EnvironmentSetupAgentDialog';
import { EnvironmentDialog } from '../EnvironmentDialog';
import { snapshotBadge } from '../environment-build-display';

type EnvironmentsSectionProps = {
  organizationId?: string;
  canManage: boolean;
  onSetupStarted: () => void;
};

export function EnvironmentsSection({
  organizationId,
  canManage,
  onSetupStarted,
}: EnvironmentsSectionProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const setupToggle = useEnvironmentSetupEnabled({ organizationId });
  const query = useCloudAgentEnvironmentsForOwner({ organizationId });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogEnvironmentId, setDialogEnvironmentId] = useState<string | null>(null);
  const [dialogRepository, setDialogRepository] = useState<EnvironmentRepository | undefined>();

  const repoChoices = useEnvironmentRepositoryChoices(organizationId);

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

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environments</h3>
          <p className="text-muted-foreground text-xs">
            Setup commands, variables, secrets, and a sandbox size for a repository or a group of
            repositories. New sessions use the environment that contains their repository. When
            several do, you choose one.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {setupToggle.data?.canStart === true && (
              <Button
                variant="secondary"
                size="sm"
                className="pointer-coarse:min-h-11"
                onClick={() => setSetupOpen(true)}
              >
                Set up with agent
              </Button>
            )}
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
                          {choices.map(choice => (
                            <CommandItem
                              key={`${platform}:${choice.label}`}
                              value={`${platform}:${choice.label}`}
                              onSelect={() => openCreate(choice)}
                              className="flex items-center gap-2"
                            >
                              <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
                              <span className="flex-1 truncate" title={choice.label}>
                                {choice.label}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      );
                    })}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
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
            Add one to give a repository setup commands, variables, secrets, a sandbox size, and
            network access.
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
            />
          ))}
        </div>
      )}

      <EnvironmentSetupAgentDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onStarted={onSetupStarted}
        organizationId={organizationId}
      />
      <EnvironmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSetupStarted={onSetupStarted}
        organizationId={organizationId}
        repository={dialogRepository}
        repositoryLabel={dialogRepository ? repositoryLabel(dialogRepository) : undefined}
        environmentId={dialogEnvironmentId}
        canManage={canManage}
        onSaved={() => setDialogOpen(false)}
        onDeleted={() => setDialogOpen(false)}
      />
    </section>
  );
}

function EnvironmentRow({
  environment,
  organizationId,
  canManage,
  onEdit,
}: {
  environment: EnvironmentSummary;
  organizationId?: string;
  canManage: boolean;
  onEdit: () => void;
}) {
  const setupRuns = useEnvironmentSetupRunsForEnvironment(environment.id, { organizationId });
  const setupInProgress = setupRuns.data?.some(run => isOpenEnvironmentSetupRun(run.status));
  const { data: buildStatus } = useEnvironmentBuildStatus(environment.id, { organizationId });
  const badge = snapshotBadge(buildStatus, Date.now());
  const members = environmentMembers(environment);
  const primary = members[0];
  return (
    <button
      type="button"
      className="focus-visible:ring-ring hover:bg-accent flex w-full cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2"
      onClick={onEdit}
      aria-label={`${canManage ? 'Edit' : 'View'} environment ${environment.name}`}
    >
      <Boxes className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
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
          {setupInProgress && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Setup in progress
            </Badge>
          )}
          {badge && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {badge}
            </Badge>
          )}
        </span>
        {members.map(member => (
          <span
            key={`${member.platform}:${member.repoFullName}`}
            className="text-muted-foreground block truncate text-xs"
            title={member.repoFullName}
          >
            {member.repoFullName}
          </span>
        ))}
      </span>
    </button>
  );
}

function repositoryLabel(repository: EnvironmentRepository): string {
  return repository.platform === 'gitlab' ? repository.projectPath : repository.fullName;
}

function platformLabel(platform: 'github' | 'gitlab' | 'bitbucket'): string {
  return platform === 'gitlab' ? 'GL' : platform === 'bitbucket' ? 'BB' : 'GH';
}
