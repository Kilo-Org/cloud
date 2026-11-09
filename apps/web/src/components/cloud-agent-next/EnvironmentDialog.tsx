'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ChevronRight, Loader2, Play, Terminal, KeyRound } from 'lucide-react';
import {
  ENVIRONMENT_LIMITS,
  validateEnvironmentCommands,
  validateEnvironmentName,
} from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EnvironmentDeleteDialog } from './EnvironmentDeleteDialog';
import { allocationSupportsMultiRepository } from '@kilocode/worker-utils/sandbox-allocation';
import {
  useCloudAgentEnvironment,
  useCloudAgentEnvironmentMutations,
  type EnvironmentRepository,
  type EnvironmentResponse,
} from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentProfiles } from '@/hooks/useEnvironmentProfiles';
import {
  hasEnvironmentFormChanges,
  buildEgressPolicy,
  toEnvironmentCommands,
  toEnvironmentScript,
  toNetworkAccessDraft,
} from './environment-form';
import { EnvironmentNetworkField } from './EnvironmentNetworkField';
import { EnvironmentBuildPanel } from './EnvironmentBuildPanel';
import {
  buildEnvironmentVariableChanges,
  formatEnvironmentVariables,
} from './environment-variables';
import { describeEnvironmentProfileImpact } from './environment-profile-impact';
import { EnvironmentRepositoriesField } from './EnvironmentRepositoriesField';
import {
  repositoriesForEnvironment,
  repositoryName,
  sameRepositories,
} from './environment-repositories';
import { EnvironmentSandboxField } from './EnvironmentSandboxField';
import { EnvironmentScriptsEditor } from './EnvironmentScriptsEditor';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';
import { splitRepositoryName, toSelectableAllocation } from './settings/settings-options';

type EnvironmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
  repositoryLabel?: string;
  environmentId: string | null;
  selectedProfileId?: string | null;
  canManage: boolean;
  onSaved: (environmentId: string) => void;
  onDeleted: () => void;
};

export function EnvironmentDialog({
  open,
  onOpenChange,
  environmentId,
  ...props
}: EnvironmentDialogProps) {
  const detailQuery = useCloudAgentEnvironment(environmentId, {
    organizationId: props.organizationId,
    enabled: open,
  });
  const isLoading = !!environmentId && detailQuery.isLoading;
  const isError =
    !!environmentId && (detailQuery.isError || (!detailQuery.isLoading && !detailQuery.data));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {isLoading || isError ? (
          <>
            <DialogHeader className="p-6">
              <DialogTitle>Environment</DialogTitle>
              <DialogDescription>
                {isError ? 'Could not load this environment.' : 'Loading environment…'}
              </DialogDescription>
            </DialogHeader>
            {isLoading && (
              <div className="flex justify-center pb-6">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )}
          </>
        ) : (
          <EnvironmentForm key={environmentId ?? 'new'} {...props} existing={detailQuery.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type EnvironmentFormProps = Omit<
  EnvironmentDialogProps,
  'open' | 'onOpenChange' | 'environmentId'
> & { existing: EnvironmentResponse | undefined };
type EditorPage = 'overview' | 'scripts' | 'start' | 'variables';

function EnvironmentForm({
  organizationId,
  repository,
  repositoryLabel,
  selectedProfileId,
  canManage,
  existing,
  onSaved,
  onDeleted,
}: EnvironmentFormProps) {
  const { createEnvironment, updateEnvironment, deleteEnvironment } =
    useCloudAgentEnvironmentMutations();
  const [page, setPage] = useState<EditorPage>('overview');
  const [initialRepositories] = useState<EnvironmentRepository[]>(() =>
    existing ? repositoriesForEnvironment(existing) : repository ? [repository] : []
  );
  const [repositories, setRepositories] = useState(initialRepositories);
  const repositoriesChanged = !sameRepositories(initialRepositories, repositories);
  const isMultiRepository = !existing || existing.repositories !== undefined || repositoriesChanged;
  const launchName = repositories[0] ? repositoryName(repositories[0]) : (repositoryLabel ?? '');
  const defaultName = splitRepositoryName(launchName).name.slice(
    0,
    ENVIRONMENT_LIMITS.MAX_NAME_LENGTH
  );
  const [name, setName] = useState(existing?.name ?? '');
  const savedName = name.trim() || defaultName;
  const [initialSandboxAllocation] = useState(() =>
    toSelectableAllocation(existing?.sandboxAllocation ?? null)
  );
  const [sandboxAllocation, setSandboxAllocation] = useState(initialSandboxAllocation);
  // Retain the baseline shown when editing starts, even if queries refresh in the background.
  const [initialNetworkAccess] = useState(() =>
    toNetworkAccessDraft(existing?.egressMode ?? null, existing?.egressAllowlist ?? null)
  );
  const [networkAccess, setNetworkAccess] = useState(initialNetworkAccess);
  const [networkAccessError, setNetworkAccessError] = useState<string | null>(null);
  const sandboxRepository = repositories[0]
    ? { platform: repositories[0].platform, fullName: repositoryName(repositories[0]) }
    : undefined;
  const profileQuery = useEnvironmentProfiles({
    organizationId,
    repository: sandboxRepository,
    selectedProfileId,
    environment: isMultiRepository ? { repositories } : null,
  });
  const [initialScript] = useState(() => toEnvironmentScript(existing?.commands ?? []));
  const [script, setScript] = useState(initialScript);
  // Leave existing scripts untouched when saving only variables or the sandbox size.
  const commands = existing && script === initialScript ? undefined : toEnvironmentCommands(script);
  const [initialStartScript] = useState(() => toEnvironmentScript(existing?.startCommands ?? []));
  const [startScript, setStartScript] = useState(initialStartScript);
  const startCommands =
    existing && startScript === initialStartScript ? undefined : toEnvironmentCommands(startScript);
  // Retain the baseline shown when editing starts, even if queries refresh in the background.
  const [savedVariables] = useState(() => ({
    plainVars: existing?.plainVars ?? [],
    secretKeys: existing?.secretKeys ?? [],
  }));
  const [initialVariablesText] = useState(() =>
    formatEnvironmentVariables(savedVariables.plainVars, savedVariables.secretKeys)
  );
  const [variablesText, setVariablesText] = useState(initialVariablesText);
  const hasUnsavedChanges =
    hasEnvironmentFormChanges(
      {
        name: existing?.name ?? defaultName,
        script: initialScript,
        startScript: initialStartScript,
        variablesText: initialVariablesText,
        sandboxAllocation: initialSandboxAllocation,
        networkAccess: initialNetworkAccess,
      },
      { name: savedName, script, startScript, variablesText, sandboxAllocation, networkAccess }
    ) || repositoriesChanged;
  const [error, setError] = useState<string | null>(null);
  let variables: ReturnType<typeof buildEnvironmentVariableChanges> | undefined;
  let variablesError: string | null = null;
  try {
    variables = buildEnvironmentVariableChanges(
      variablesText,
      savedVariables.plainVars,
      savedVariables.secretKeys
    );
  } catch (caught) {
    variablesError = caught instanceof Error ? caught.message : 'Check the environment variables.';
  }
  const impact = describeEnvironmentProfileImpact(profileQuery.profiles, variables?.keys ?? []);
  const hasScript = script.trim().length > 0;
  const hasStartScript = startScript.trim().length > 0;
  const isSaving = createEnvironment.isPending || updateEnvironment.isPending;
  const changePage = (next: EditorPage) => {
    setError(null);
    setPage(next);
  };

  const handleSave = async () => {
    if (!canManage) return;
    if (!variables) {
      setPage('variables');
      return;
    }
    const egress = buildEgressPolicy(networkAccess, initialNetworkAccess);
    if (egress.error) {
      setNetworkAccessError(egress.error);
      setPage('overview');
      return;
    }
    setNetworkAccessError(null);
    setError(null);
    try {
      validateEnvironmentName(savedName);
      validateEnvironmentCommands(commands);
      validateEnvironmentCommands(startCommands, 'Start');
      if (existing) {
        await updateEnvironment.mutateAsync({
          organizationId,
          environmentId: existing.id,
          name: savedName,
          repositories: repositoriesChanged ? repositories : undefined,
          plainVars: variables.plainVars,
          secrets: variables.secrets,
          commands,
          startCommands,
          sandboxAllocation,
          ...egress.policy,
        });
        onSaved(existing.id);
      } else {
        if (repositories.length === 0) {
          setError('Select a repository first.');
          return;
        }
        const secrets = Object.fromEntries(
          variables.secrets.flatMap(change =>
            'value' in change ? [[change.key, change.value]] : []
          )
        );
        const created = await createEnvironment.mutateAsync({
          organizationId,
          name: savedName,
          repositories,
          plainVars: variables.plainVars,
          secrets,
          commands,
          startCommands,
          sandboxAllocation,
          ...egress.policy,
        });
        onSaved(created.id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the environment.');
    }
  };
  const handleDelete = async () => {
    if (!canManage || !existing) return;
    try {
      await deleteEnvironment.mutateAsync({ organizationId, environmentId: existing.id });
      toast.success('Environment deleted');
      onDeleted();
    } catch {
      toast.error('Failed to delete environment');
      throw new Error('Could not delete environment');
    }
  };

  return (
    <>
      <DialogHeader className="shrink-0 px-6 pt-6 pb-4 text-left">
        <div className="flex items-center gap-2 pr-8">
          {page !== 'overview' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 shrink-0"
              aria-label="Back to environment"
              onClick={() => changePage('overview')}
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <DialogTitle>
            {page === 'scripts'
              ? 'Setup script'
              : page === 'start'
                ? 'Start script'
                : page === 'variables'
                  ? 'Environment variables'
                  : existing
                    ? 'Environment'
                    : 'Set up environment'}
          </DialogTitle>
        </div>
        <DialogDescription className="sr-only">
          Configure repositories, setup and start scripts, and environment variables.
        </DialogDescription>
        {!canManage && (
          <p className="text-muted-foreground text-xs">
            View only. Organization owners and admins can edit this environment.
          </p>
        )}
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
        <fieldset disabled={isSaving || deleteEnvironment.isPending} className="min-w-0 space-y-5">
          {page === 'overview' && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="environment-name" className="text-xs">
                  Name (optional)
                </Label>
                <Input
                  id="environment-name"
                  value={name}
                  readOnly={!canManage}
                  onChange={event => setName(event.target.value)}
                  placeholder={defaultName}
                  maxLength={ENVIRONMENT_LIMITS.MAX_NAME_LENGTH}
                />
              </div>
              <fieldset disabled={!canManage} className="min-w-0">
                <EnvironmentRepositoriesField
                  organizationId={organizationId}
                  repositories={repositories}
                  onChange={setRepositories}
                />
              </fieldset>
              {sandboxRepository && (
                <EnvironmentSandboxField
                  organizationId={organizationId}
                  repository={sandboxRepository}
                  value={sandboxAllocation}
                  disabled={!canManage || isSaving}
                  onChange={setSandboxAllocation}
                  isAllowed={isMultiRepository ? allocationSupportsMultiRepository : undefined}
                />
              )}
              <EnvironmentNetworkField
                value={networkAccess}
                sandboxAllocation={sandboxAllocation}
                error={networkAccessError}
                disabled={!canManage || isSaving}
                onChange={next => {
                  setNetworkAccessError(null);
                  setNetworkAccess(next);
                }}
              />
              <div className="space-y-3">
                <EditorRow
                  icon={<Terminal className="size-4" />}
                  label="Setup script"
                  detail={
                    hasScript
                      ? 'Configure your setup script'
                      : 'Install dependencies and prepare your repository'
                  }
                  onClick={() => changePage('scripts')}
                />
                <EditorRow
                  icon={<Play className="size-4" />}
                  label="Start script"
                  detail={
                    hasStartScript
                      ? 'Configure your start script'
                      : 'Start services when a workspace starts'
                  }
                  onClick={() => changePage('start')}
                />
                <EditorRow
                  icon={<KeyRound className="size-4" />}
                  label="Environment variables"
                  detail={
                    variablesError
                      ? 'Check variable format'
                      : variables?.keys.length
                        ? `${variables.keys.length} ${variables.keys.length === 1 ? 'variable' : 'variables'}`
                        : 'Add configuration and credentials'
                  }
                  onClick={() => changePage('variables')}
                />
              </div>
            </>
          )}
          {page === 'scripts' && (
            <EnvironmentScriptsEditor script={script} onChange={setScript} readOnly={!canManage} />
          )}
          {page === 'start' && (
            <EnvironmentScriptsEditor
              kind="start"
              script={startScript}
              onChange={setStartScript}
              readOnly={!canManage}
            />
          )}
          {page === 'variables' && (
            <EnvironmentVariablesEditor
              text={variablesText}
              readOnly={!canManage}
              onChange={setVariablesText}
              removedKeys={variables?.removedKeys ?? []}
              error={variablesError}
            />
          )}
        </fieldset>
        {page === 'overview' &&
          (existing ? (
            <EnvironmentBuildPanel
              organizationId={organizationId}
              environmentId={existing.id}
              canManage={canManage}
              hasUnsavedChanges={hasUnsavedChanges || isSaving || deleteEnvironment.isPending}
            />
          ) : (
            <p className="text-muted-foreground text-xs">Save to enable snapshot builds.</p>
          ))}
        {profileQuery.isError ? (
          <p role="alert" className="text-destructive text-xs">
            Could not check profile settings.{' '}
            <button type="button" className="underline" onClick={() => void profileQuery.retry()}>
              Retry
            </button>
          </p>
        ) : profileQuery.isLoading ? (
          <p role="status" className="text-muted-foreground text-xs">
            Checking profile settings…
          </p>
        ) : (
          impact.overrides.length > 0 && (
            <div className="bg-muted rounded-md px-3 py-2 text-xs leading-5">
              <p className="font-medium">Profile values override these variables:</p>
              <ul>
                {impact.overrides.map(({ key, profileName }) => (
                  <li key={key} className="break-words">
                    <code>{key}</code> · {profileName}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <DialogFooter className="shrink-0 gap-3 border-t px-6 py-4 sm:items-center sm:justify-between">
        <div>
          {canManage && existing && page === 'overview' && (
            <EnvironmentDeleteDialog
              repositoryName={repositories.map(repositoryName).join(', ')}
              onDelete={handleDelete}
              isDeleting={deleteEnvironment.isPending}
              disabled={isSaving}
            />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={isSaving}>
              {canManage ? 'Cancel' : 'Close'}
            </Button>
          </DialogClose>
          {canManage && (
            <Button
              size="sm"
              onClick={handleSave}
              disabled={
                isSaving ||
                deleteEnvironment.isPending ||
                profileQuery.isLoading ||
                profileQuery.isError
              }
            >
              {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}Save environment
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}

function EditorRow({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="border-input bg-input/30 hover:bg-accent hover:border-muted-foreground/50 focus-visible:ring-ring flex w-full cursor-pointer transition-colors items-center gap-3 rounded-md border px-4 py-4 text-left outline-none focus-visible:ring-2"
      onClick={onClick}
    >
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground mt-1 block text-xs">{detail}</span>
      </span>
      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
    </button>
  );
}
