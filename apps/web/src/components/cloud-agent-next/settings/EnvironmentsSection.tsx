'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { cn } from '@/lib/utils';
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
import { EnvironmentDetailPane, type EnvironmentEditorPage } from '../EnvironmentDialog';
import { snapshotBadge } from '../environment-build-display';

type EnvironmentsSectionProps = {
  organizationId?: string;
  canManage: boolean;
};

export function EnvironmentsSection({ organizationId, canManage }: EnvironmentsSectionProps) {
  const query = useCloudAgentEnvironmentsForOwner({ organizationId });
  const repoChoices = useEnvironmentRepositoryChoices(organizationId);
  const environments = query.data ?? [];

  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createRepository, setCreateRepository] = useState<EnvironmentRepository | null>(null);
  const [createVersion, setCreateVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorPage, setEditorPage] = useState<EnvironmentEditorPage>('overview');
  const [editorVersion, setEditorVersion] = useState(0);

  useEffect(() => {
    if (createRepository || selectedId !== null) return;
    const first = environments[0];
    if (first) setSelectedId(first.id);
  }, [createRepository, environments, selectedId]);

  const canLeaveEditor = useCallback(() => {
    if (!dirty) return true;
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm('Discard unsaved changes to this environment?');
  }, [dirty]);

  const selectEnvironment = (environmentId: string) => {
    if (saving) return;
    if (environmentId === selectedId && !createRepository) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setEditorPage('overview');
    setCreateRepository(null);
    setSelectedId(environmentId);
  };

  const openCreate = (choice: EnvironmentRepositoryChoice) => {
    if (saving) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setEditorPage('overview');
    setPickerOpen(false);
    setCreateVersion(version => version + 1);
    setCreateRepository(choice.repository);
    setSelectedId(null);
  };

  const cancelCreate = () => {
    if (saving) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setCreateRepository(null);
  };

  const handleCreated = (environmentId: string) => {
    setSaving(false);
    if (!createRepository) return;
    setDirty(false);
    setCreateRepository(null);
    setSelectedId(environmentId);
  };

  const handleSaved = (environmentId: string) => {
    setSaving(false);
    if (selectedId !== null && selectedId !== environmentId) return;
    setDirty(false);
    setSelectedId(environmentId);
    setEditorVersion(version => version + 1);
  };

  const handleDeleted = () => {
    if (!selectedId) return;
    const index = environments.findIndex(environment => environment.id === selectedId);
    const remaining = environments.filter(environment => environment.id !== selectedId);
    const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
    setSaving(false);
    setDirty(false);
    setEditorPage('overview');
    setSelectedId(next?.id ?? null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex max-h-40 shrink-0 flex-col border-b md:max-h-none md:w-64 md:border-r md:border-b-0 lg:w-72">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p className="text-muted-foreground hidden border-b px-3 py-2 text-xs leading-5 md:block">
            New sessions use the environment containing their repository. When several match, you
            choose one.
          </p>
          {query.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : query.isError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <p className="text-destructive text-xs">Failed to load environments.</p>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </div>
          ) : environments.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No environments yet.
            </p>
          ) : (
            <div className="py-1">
              {environments.map(environment => (
                <EnvironmentRow
                  key={environment.id}
                  environment={environment}
                  organizationId={organizationId}
                  canManage={canManage}
                  selected={!createRepository && selectedId === environment.id}
                  disabled={saving}
                  onSelect={() => selectEnvironment(environment.id)}
                />
              ))}
            </div>
          )}
        </div>

        {canManage && (
          <div className="border-t p-2">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  className="text-muted-foreground hover:text-foreground w-full justify-start gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add environment
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[320px] max-w-[calc(100vw-2rem)] p-0" align="start">
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

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {query.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : createRepository ? (
          <EnvironmentDetailPane
            key={`new:${repositoryLabel(createRepository)}:${createVersion}`}
            environmentId={null}
            organizationId={organizationId}
            repository={createRepository}
            repositoryLabel={repositoryLabel(createRepository)}
            canManage={canManage}
            initialPage={editorPage}
            onPageChange={setEditorPage}
            onSavingChange={setSaving}
            onSaved={handleCreated}
            onDeleted={() => undefined}
            onCancel={cancelCreate}
            onDirtyChange={setDirty}
          />
        ) : selectedId ? (
          <EnvironmentDetailPane
            key={`${selectedId}:${editorVersion}`}
            environmentId={selectedId}
            organizationId={organizationId}
            canManage={canManage}
            initialPage={editorPage}
            onPageChange={setEditorPage}
            onSavingChange={setSaving}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onDirtyChange={setDirty}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Boxes className="text-muted-foreground size-6" aria-hidden />
            <p className="text-sm font-medium">
              {environments.length === 0 ? 'No environments' : 'Select an environment'}
            </p>
            <p className="text-muted-foreground max-w-sm text-xs">
              {environments.length === 0
                ? 'Add one to give a repository setup commands, variables, secrets, a sandbox size, and network access.'
                : 'Choose an environment from the list to view or edit it.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentRow({
  environment,
  organizationId,
  canManage,
  selected,
  disabled,
  onSelect,
}: {
  environment: EnvironmentSummary;
  organizationId?: string;
  canManage: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { data: buildStatus } = useEnvironmentBuildStatus(environment.id, { organizationId });
  const badge = snapshotBadge(buildStatus, Date.now());
  const members = environmentMembers(environment);
  const primary = members[0];
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${canManage ? 'Edit' : 'View'} environment ${environment.name}`}
      disabled={disabled}
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-ring outline-none focus-visible:ring-2 pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-60',
        selected ? 'bg-accent text-foreground' : 'hover:bg-accent/50 text-muted-foreground'
      )}
      onClick={onSelect}
    >
      <Boxes className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
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
