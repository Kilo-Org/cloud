'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  Play,
  Terminal,
} from 'lucide-react';
import {
  ENVIRONMENT_LIMITS,
  validateEnvironmentCommands,
  validateEnvironmentName,
} from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EnvironmentSecretRequestList } from './EnvironmentSecretRequestList';
import { omitUnresolvedSeededSecrets, seedPendingSecretKeys } from './environment-setup-secrets';
import {
  useEnvironmentSetupEnabled,
  useEnvironmentSetupRunMutations,
  type SetupRunResponse,
} from '@/hooks/useEnvironmentSetupRuns';
import { EnvironmentSetupAgentFields } from './EnvironmentSetupAgentFields';
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
  toEnvironmentCommands,
  toEnvironmentScript,
  toNetworkAccessDraft,
} from './environment-form';
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
  initialPage?: EnvironmentEditorPage;
  setupRun?: SetupRunResponse;
  onSetupStarted?: () => void;
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
  const [saving, setSaving] = useState(false);
  const detailQuery = useCloudAgentEnvironment(environmentId, {
    organizationId: props.organizationId,
    enabled: open,
  });
  const isLoading = !!environmentId && detailQuery.isLoading;
  const isError = !!environmentId && !detailQuery.data && !detailQuery.isLoading;
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!saving) onOpenChange(next);
      }}
    >
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
          <EnvironmentForm
            key={environmentId ?? 'new'}
            {...props}
            existing={detailQuery.data}
            variant="dialog"
            onSavingChange={setSaving}
            onSetupStarted={() => {
              onOpenChange(false);
              props.onSetupStarted?.();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type EnvironmentDetailPaneProps = {
  active?: boolean;
  onSetupStarted?: () => void;
  environmentId: string | null;
  organizationId?: string;
  repository?: EnvironmentRepository;
  repositoryLabel?: string;
  selectedProfileId?: string | null;
  canManage: boolean;
  initialPage?: EnvironmentEditorPage;
  onPageChange?: (page: EnvironmentEditorPage) => void;
  onSavingChange?: (saving: boolean) => void;
  onSaved: (environmentId: string) => void;
  onDeleted: () => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function EnvironmentDetailPane({
  active = true,
  environmentId,
  onCancel,
  onDirtyChange,
  onPageChange,
  onSavingChange,
  initialPage,
  ...props
}: EnvironmentDetailPaneProps) {
  const detailQuery = useCloudAgentEnvironment(environmentId, {
    organizationId: props.organizationId,
    enabled: active && !!environmentId,
  });
  const isLoading = !!environmentId && detailQuery.isLoading;
  const isError = !!environmentId && !detailQuery.data && !detailQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="text-muted-foreground size-5" aria-hidden />
        <p className="text-sm">Could not load this environment.</p>
        <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <EnvironmentForm
      key={environmentId ?? 'new'}
      {...props}
      existing={detailQuery.data}
      variant="inline"
      active={active}
      initialPage={initialPage}
      onPageChange={onPageChange}
      onSavingChange={onSavingChange}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
    />
  );
}

type EnvironmentFormProps = Omit<
  EnvironmentDialogProps,
  'open' | 'onOpenChange' | 'environmentId' | 'repository'
> & {
  repository?: EnvironmentRepository;
  existing: EnvironmentResponse | undefined;
  variant: 'dialog' | 'inline';
  active?: boolean;
  initialPage?: EnvironmentEditorPage;
  onPageChange?: (page: EnvironmentEditorPage) => void;
  onSavingChange?: (saving: boolean) => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};
export type EnvironmentEditorPage = 'overview' | 'scripts' | 'start' | 'variables';

function isEditorPage(value: string): value is EnvironmentEditorPage {
  return value === 'overview' || value === 'scripts' || value === 'start' || value === 'variables';
}

function EnvironmentForm({
  organizationId,
  repository,
  repositoryLabel,
  selectedProfileId,
  canManage,
  setupRun,
  onSetupStarted,
  existing,
  variant,
  active = true,
  initialPage,
  onPageChange,
  onSavingChange,
  onSaved,
  onDeleted,
  onCancel,
  onDirtyChange,
}: EnvironmentFormProps) {
  const { createEnvironment, updateEnvironment, deleteEnvironment } =
    useCloudAgentEnvironmentMutations();
  const [page, setPage] = useState<EnvironmentEditorPage>(initialPage ?? 'overview');
  const agentFormId = useId();
  const [setupMethod, setSetupMethod] = useState<'manual' | 'agent'>('manual');
  const setupToggle = useEnvironmentSetupEnabled({ organizationId, enabled: active && canManage });
  const setupWithAgent =
    setupMethod === 'agent' && canManage && setupToggle.data?.canStart === true;
  const [agentPending, setAgentPending] = useState(false);
  const [agentValid, setAgentValid] = useState(false);
  const [agentDirty, setAgentDirty] = useState(false);
  const { resolveSecretRequests } = useEnvironmentSetupRunMutations();
  const [skippedSecrets, setSkippedSecrets] = useState<string[]>([]);
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
  const networkAccess = initialNetworkAccess;
  const sandboxRepository = repositories[0]
    ? { platform: repositories[0].platform, fullName: repositoryName(repositories[0]) }
    : undefined;
  const profileQuery = useEnvironmentProfiles({
    enabled: active,
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
  const [savedVariables, setSavedVariables] = useState<{
    plainVars: { key: string; value: string }[];
    secretKeys: string[];
  }>(() => ({
    plainVars: existing?.plainVars ?? [],
    secretKeys: existing?.secretKeys ?? [],
  }));
  const [initialVariablesText] = useState(() =>
    formatEnvironmentVariables(savedVariables.plainVars, savedVariables.secretKeys)
  );
  const [seededSecrets] = useState(() =>
    seedPendingSecretKeys(initialVariablesText, setupRun?.secretRequests ?? [])
  );
  const [variablesText, setVariablesText] = useState(seededSecrets.text);
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
  const hasManualConfigurationChanges = existing
    ? hasUnsavedChanges
    : script !== initialScript ||
      startScript !== initialStartScript ||
      variablesText !== initialVariablesText ||
      sandboxAllocation !== initialSandboxAllocation;
  const [error, setError] = useState<string | null>(null);
  let variables: ReturnType<typeof buildEnvironmentVariableChanges> | undefined;
  let variablesError: string | null = null;
  try {
    variables = buildEnvironmentVariableChanges(
      omitUnresolvedSeededSecrets(variablesText, seededSecrets.seededKeys, skippedSecrets),
      savedVariables.plainVars,
      savedVariables.secretKeys
    );
  } catch (caught) {
    variablesError = caught instanceof Error ? caught.message : 'Check the environment variables.';
  }
  const impact = describeEnvironmentProfileImpact(profileQuery.profiles, variables?.keys ?? []);
  const hasScript = script.trim().length > 0;
  const hasStartScript = startScript.trim().length > 0;
  const isSaving =
    agentPending ||
    resolveSecretRequests.isPending ||
    createEnvironment.isPending ||
    updateEnvironment.isPending;
  const deletePending = deleteEnvironment.isPending;
  const isInline = variant === 'inline';

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges || (setupWithAgent && agentDirty));
  }, [hasUnsavedChanges, setupWithAgent, agentDirty, onDirtyChange]);

  const busy = isSaving || deletePending;

  useEffect(() => {
    onSavingChange?.(busy);
  }, [busy, onSavingChange]);

  const changePage = (next: EnvironmentEditorPage) => {
    setError(null);
    setPage(next);
    onPageChange?.(next);
  };

  const handleSave = async () => {
    if (!canManage) return;
    if (!variables) {
      changePage('variables');
      return;
    }
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
        });
        if (setupRun) {
          setSavedVariables({
            plainVars: Object.entries(variables.plainVars).map(([key, value]) => ({ key, value })),
            secretKeys: variables.keys.filter(key => !(key in variables.plainVars)),
          });
          try {
            await resolveSecretRequests.mutateAsync({
              organizationId,
              runId: setupRun.id,
              skipped: skippedSecrets,
            });
          } catch (caught) {
            setError(
              `The environment was saved, but the requests could not be resolved: ${caught instanceof Error ? caught.message : 'Try saving again.'}`
            );
            return;
          }
        }
        if (isInline) toast.success('Environment saved');
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
        });
        if (isInline) toast.success('Environment created');
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

  const overviewBaseFields = (
    <>
      <div className="grid gap-2">
        <Label htmlFor="environment-name" className="text-xs">
          Name (optional)
        </Label>
        <Input
          id="environment-name"
          type="text"
          value={name}
          readOnly={!canManage || (setupWithAgent && !!existing)}
          onChange={event => setName(event.target.value)}
          placeholder={defaultName}
          maxLength={ENVIRONMENT_LIMITS.MAX_NAME_LENGTH}
        />
      </div>
      <fieldset disabled={!canManage || (setupWithAgent && !!existing)} className="min-w-0">
        <EnvironmentRepositoriesField
          organizationId={organizationId}
          repositories={repositories}
          onChange={setRepositories}
        />
      </fieldset>
      {!setupWithAgent && sandboxRepository && (
        <EnvironmentSandboxField
          organizationId={organizationId}
          repository={sandboxRepository}
          value={sandboxAllocation}
          disabled={!canManage || isSaving}
          onChange={setSandboxAllocation}
          isAllowed={isMultiRepository ? allocationSupportsMultiRepository : undefined}
        />
      )}

      {!existing?.isDraft && canManage && setupToggle.data?.canStart === true && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Setup method</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(['manual', 'agent'] as const).map(method => (
              <label
                key={method}
                className="flex cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-11"
              >
                <input
                  type="radio"
                  name={`environment-setup-method-${agentFormId}`}
                  value={method}
                  checked={setupMethod === method}
                  disabled={method === 'agent' && hasManualConfigurationChanges}
                  onChange={() => setSetupMethod(method)}
                  className="accent-primary size-4"
                />
                {method === 'manual' ? 'Manually' : 'With an agent'}
              </label>
            ))}
          </div>
          {hasManualConfigurationChanges && !setupWithAgent && (
            <p className="text-muted-foreground text-xs">
              Save manual configuration changes before starting agent setup.
            </p>
          )}
        </fieldset>
      )}
      {setupWithAgent && (
        <EnvironmentSetupAgentFields
          formId={agentFormId}
          organizationId={organizationId}
          repositories={repositories}
          name={savedName}
          targetEnvironmentId={existing?.id}
          onPendingChange={setAgentPending}
          onValidChange={setAgentValid}
          onDirtyChange={setAgentDirty}
          onStarted={() => onSetupStarted?.()}
        />
      )}
    </>
  );

  const buildPanel = existing?.isDraft ? null : existing ? (
    <EnvironmentBuildPanel
      organizationId={organizationId}
      environmentId={existing.id}
      canManage={canManage}
      hasUnsavedChanges={hasUnsavedChanges || isSaving || deletePending}
      active={active}
    />
  ) : (
    <p className="text-muted-foreground text-xs">Save to enable snapshot builds.</p>
  );

  const profileFeedback = profileQuery.isError ? (
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
  );

  const errorMessage = error && (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );

  const secretRequests = setupRun && (
    <EnvironmentSecretRequestList
      run={setupRun}
      organizationId={organizationId}
      skipped={skippedSecrets}
      onSkippedChange={setSkippedSecrets}
      disabled={!canManage || isSaving}
    />
  );
  const saveAction =
    canManage &&
    (setupWithAgent ? (
      <Button type="submit" form={agentFormId} size="sm" disabled={!agentValid || isSaving}>
        {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}Start setup
      </Button>
    ) : (
      <Button
        size="sm"
        onClick={handleSave}
        disabled={isSaving || deletePending || profileQuery.isLoading || profileQuery.isError}
      >
        {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}Save environment
      </Button>
    ));

  const handleTabChange = (value: string) => {
    if (isEditorPage(value)) changePage(value);
  };

  if (isInline) {
    return (
      <Tabs value={page} onValueChange={handleTabChange} className="flex h-full min-w-0 flex-col">
        <div className="shrink-0 border-b">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <h3 className="truncate text-sm font-semibold">
              {existing ? existing.name : 'New environment'}
            </h3>
          </div>
          {!canManage && (
            <p className="text-muted-foreground border-t px-4 py-2 text-xs" role="note">
              View only. Organization owners and admins can edit this environment.
            </p>
          )}
        </div>
        <div className="shrink-0 overflow-x-auto border-b px-2 py-1">
          <TabsList aria-label="Environment configuration" className="w-max">
            <TabsTrigger
              disabled={isSaving}
              value="overview"
              className="gap-1 text-xs pointer-coarse:min-h-11"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              disabled={setupWithAgent || isSaving}
              value="scripts"
              className="gap-1 text-xs pointer-coarse:min-h-11"
            >
              Snapshot
            </TabsTrigger>
            <TabsTrigger
              disabled={setupWithAgent || isSaving}
              value="start"
              className="gap-1 text-xs pointer-coarse:min-h-11"
            >
              Workspace start
            </TabsTrigger>
            <TabsTrigger
              disabled={setupWithAgent || isSaving}
              value="variables"
              className="gap-1 text-xs pointer-coarse:min-h-11"
            >
              Variables
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {page === 'scripts' && buildPanel}
          <fieldset disabled={isSaving || deletePending} className="min-w-0 space-y-5">
            <TabsContent value="overview" className="mt-0 space-y-5">
              {overviewBaseFields}
            </TabsContent>
            <TabsContent value="scripts" className="mt-0">
              <EnvironmentScriptsEditor
                script={script}
                onChange={setScript}
                readOnly={!canManage}
              />
            </TabsContent>
            <TabsContent value="start" className="mt-0">
              <EnvironmentScriptsEditor
                kind="start"
                script={startScript}
                onChange={setStartScript}
                readOnly={!canManage}
              />
            </TabsContent>
            <TabsContent value="variables" className="mt-0 space-y-4">
              {secretRequests}
              <EnvironmentVariablesEditor
                text={variablesText}
                readOnly={!canManage}
                onChange={setVariablesText}
                removedKeys={variables?.removedKeys ?? []}
                error={variablesError}
              />
            </TabsContent>
          </fieldset>
          {profileFeedback}
          {errorMessage}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <div>
            {canManage && existing && (
              <EnvironmentDeleteDialog
                repositoryName={repositories.map(repositoryName).join(', ')}
                onDelete={handleDelete}
                isDeleting={deletePending}
                disabled={isSaving}
              />
            )}
          </div>
          <div className="ml-auto flex justify-end gap-2">
            {!existing && onCancel && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={isSaving}
              >
                Cancel
              </Button>
            )}
            {saveAction}
          </div>
        </div>
      </Tabs>
    );
  }

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
              ? 'Snapshot build script'
              : page === 'start'
                ? 'Workspace start script'
                : page === 'variables'
                  ? 'Environment variables'
                  : existing
                    ? 'Environment'
                    : 'Set up environment'}
          </DialogTitle>
        </div>
        <DialogDescription className="sr-only">
          Configure repositories, snapshot build and workspace start scripts, and environment
          variables.
        </DialogDescription>
        {!canManage && (
          <p className="text-muted-foreground text-xs">
            View only. Organization owners and admins can edit this environment.
          </p>
        )}
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
        <fieldset disabled={isSaving || deletePending} className="min-w-0 space-y-5">
          {page === 'overview' && (
            <>
              {overviewBaseFields}
              {!setupWithAgent && (
                <div className="space-y-3">
                  <EditorRow
                    icon={<Terminal className="size-4" />}
                    label="Snapshot build script"
                    detail={
                      hasScript
                        ? 'Configure your snapshot build script'
                        : 'Install dependencies and prepare your repository'
                    }
                    onClick={() => changePage('scripts')}
                  />
                  <EditorRow
                    icon={<Play className="size-4" />}
                    label="Workspace start script"
                    detail={
                      hasStartScript
                        ? 'Configure your workspace start script'
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
              )}
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
            <>
              {secretRequests}
              <EnvironmentVariablesEditor
                text={variablesText}
                readOnly={!canManage}
                onChange={setVariablesText}
                removedKeys={variables?.removedKeys ?? []}
                error={variablesError}
              />
            </>
          )}
        </fieldset>
        {!setupWithAgent && (page === 'overview' || page === 'scripts') && buildPanel}
        {profileFeedback}
        {errorMessage}
      </div>
      <DialogFooter className="shrink-0 gap-3 border-t px-6 py-4 sm:items-center sm:justify-between">
        <div>
          {canManage && existing && page === 'overview' && (
            <EnvironmentDeleteDialog
              repositoryName={repositories.map(repositoryName).join(', ')}
              onDelete={handleDelete}
              isDeleting={deletePending}
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
          {saveAction}
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
