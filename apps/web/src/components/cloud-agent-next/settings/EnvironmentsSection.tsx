'use client';

import { useCallback, useEffect, useState } from 'react';
import { Boxes, GitBranch, Loader2, Plus, SquareDashed, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
import {
  isOpenEnvironmentSetupRun,
  useEnvironmentSetupRunsForEnvironment,
} from '@/hooks/useEnvironmentSetupRuns';
import {
  EnvironmentDetailPane,
  EnvironmentDraftBadge,
  NewEnvironmentEditor,
  type EnvironmentEditorPage,
} from '../EnvironmentDialog';
import { repositoryKey, repositoryName } from '../environment-repositories';

/** An unsaved environment. It shows as the first list row until it is created or discarded. */
type EnvironmentDraft = { repositories: EnvironmentRepository[]; version: number };

type EnvironmentsSectionProps = {
  organizationId?: string;
  canManage: boolean;
  active?: boolean;
  onSetupStarted?: () => void;
};

export function EnvironmentsSection({
  organizationId,
  canManage,
  active = true,
  onSetupStarted,
}: EnvironmentsSectionProps) {
  const query = useCloudAgentEnvironmentsForOwner({ organizationId, enabled: active });
  const repoChoices = useEnvironmentRepositoryChoices(organizationId);
  const environments = query.data ?? [];
  const listLoading = query.isLoading && !query.data;
  const listError = query.isError && !query.data;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EnvironmentDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorPage, setEditorPage] = useState<EnvironmentEditorPage>('overview');
  const [editorVersion, setEditorVersion] = useState(0);

  useEffect(() => {
    if (!active || draft || saving || query.isError) return;
    if (selectedId !== null && environments.some(environment => environment.id === selectedId)) {
      return;
    }
    const next = environments[0]?.id ?? null;
    if (next !== selectedId) {
      setDirty(false);
      setEditorPage('overview');
      setSelectedId(next);
    }
  }, [active, draft, environments, query.isError, saving, selectedId]);

  const canLeaveEditor = useCallback(() => {
    if (!dirty) return true;
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm('Discard unsaved changes to this environment?');
  }, [dirty]);

  const selectEnvironment = (environmentId: string) => {
    if (saving) return;
    if (environmentId === selectedId && !draft) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setEditorPage('overview');
    setDraft(null);
    setSelectedId(environmentId);
  };

  const openDraft = (choice: EnvironmentRepositoryChoice) => {
    if (saving) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setEditorPage('overview');
    setPickerOpen(false);
    setDraft(current => ({
      repositories: [choice.repository],
      version: (current?.version ?? 0) + 1,
    }));
  };

  const discardDraft = () => {
    if (saving) return;
    if (!canLeaveEditor()) return;
    setDirty(false);
    setEditorPage('overview');
    setDraft(null);
  };

  const changeDraftRepositories = useCallback((repositories: EnvironmentRepository[]) => {
    setDraft(current => (current ? { ...current, repositories } : current));
  }, []);

  const handleCreated = (environmentId: string) => {
    setSaving(false);
    if (!draft) return;
    setDirty(false);
    setDraft(null);
    setSelectedId(environmentId);
  };

  const handleDraftSetupStarted = () => {
    setSaving(false);
    setDirty(false);
    setDraft(null);
    onSetupStarted?.();
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
          {draft && (
            <div className="border-b py-1">
              <EnvironmentDraftRow
                repositories={draft.repositories}
                disabled={saving}
                onDiscard={discardDraft}
              />
            </div>
          )}
          {listLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : listError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <p className="text-destructive text-xs">Failed to load environments.</p>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </div>
          ) : environments.length === 0 ? (
            !draft && (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                No environments yet.
              </p>
            )
          ) : (
            <div className="py-1">
              {environments.map(environment => (
                <EnvironmentRow
                  organizationId={organizationId}
                  active={active}
                  key={environment.id}
                  environment={environment}
                  canManage={canManage}
                  selected={!draft && selectedId === environment.id}
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
                              onSelect={() => openDraft(choice)}
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
        {draft ? (
          <NewEnvironmentEditor
            key={draft.version}
            variant="inline"
            organizationId={organizationId}
            initialRepositories={draft.repositories}
            onRepositoriesChange={changeDraftRepositories}
            canManage={canManage}
            active={active}
            initialPage={editorPage}
            onPageChange={setEditorPage}
            onSetupStarted={handleDraftSetupStarted}
            onSavingChange={setSaving}
            onSaved={handleCreated}
            onDeleted={() => undefined}
            onCancel={discardDraft}
            onDirtyChange={setDirty}
          />
        ) : listLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : listError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-destructive text-xs">Failed to load environments.</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : selectedId ? (
          <EnvironmentDetailPane
            key={`${selectedId}:${editorVersion}`}
            environmentId={selectedId}
            organizationId={organizationId}
            canManage={canManage}
            active={active}
            initialPage={editorPage}
            onPageChange={setEditorPage}
            onSetupStarted={onSetupStarted}
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
                ? 'Add one to give a repository setup commands, variables, secrets, a sandbox size.'
                : 'Choose an environment from the list to view or edit it.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentRow({
  organizationId,
  active,
  environment,
  canManage,
  selected,
  disabled,
  onSelect,
}: {
  organizationId?: string;
  active: boolean;
  environment: EnvironmentSummary;
  canManage: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const setupRuns = useEnvironmentSetupRunsForEnvironment(environment.id, {
    organizationId,
    enabled: active,
  });
  const setupInProgress = setupRuns.data?.some(run => isOpenEnvironmentSetupRun(run.status));
  const members = environmentMembers(environment);
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
          {setupInProgress && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Setup in progress
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

function EnvironmentDraftRow({
  repositories,
  disabled,
  onDiscard,
}: {
  repositories: EnvironmentRepository[];
  disabled: boolean;
  onDiscard: () => void;
}) {
  return (
    <div
      aria-current="true"
      className="border-primary/50 bg-accent text-foreground mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-md border border-dashed py-1.5 pr-1 pl-2"
    >
      <SquareDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">New environment</span>
          <EnvironmentDraftBadge className="text-[10px]" />
        </span>
        {repositories.map(repository => (
          <span
            key={repositoryKey(repository)}
            className="text-muted-foreground block truncate text-xs"
            title={repositoryName(repository)}
          >
            {repositoryName(repository)}
          </span>
        ))}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-6 shrink-0 pointer-coarse:size-11"
        aria-label="Discard new environment"
        disabled={disabled}
        onClick={onDiscard}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
