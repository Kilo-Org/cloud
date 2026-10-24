'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ChevronRight, Loader2, Terminal, KeyRound } from 'lucide-react';
import {
  ENVIRONMENT_LIMITS,
  validateEnvironmentCommands,
  validateEnvironmentName,
} from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
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
import {
  useCloudAgentEnvironment,
  useCloudAgentEnvironmentMutations,
  type EnvironmentRepository,
  type EnvironmentResponse,
} from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentProfiles } from '@/hooks/useEnvironmentProfiles';
import { toEnvironmentCommands, toEnvironmentScript } from './environment-form';
import {
  buildEnvironmentVariableChanges,
  formatEnvironmentVariables,
} from './environment-variables';
import { describeEnvironmentProfileImpact } from './environment-profile-impact';
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
type EditorPage = 'overview' | 'scripts' | 'variables';

function EnvironmentForm({
  organizationId,
  repository,
  repositoryLabel,
  selectedProfileId,
  existing,
  onSaved,
  onDeleted,
}: EnvironmentFormProps) {
  const { createEnvironment, updateEnvironment, deleteEnvironment } =
    useCloudAgentEnvironmentMutations();
  const [page, setPage] = useState<EditorPage>('overview');
  const fullName =
    existing?.repoFullName ??
    repositoryLabel ??
    (repository?.platform === 'gitlab' ? repository.projectPath : repository?.fullName) ??
    '';
  const name =
    existing?.name ??
    splitRepositoryName(fullName).name.slice(0, ENVIRONMENT_LIMITS.MAX_NAME_LENGTH);
  const [sandboxAllocation, setSandboxAllocation] = useState(() =>
    toSelectableAllocation(existing?.sandboxAllocation ?? null)
  );
  const sandboxRepository = existing
    ? { platform: existing.platform, fullName }
    : repository
      ? { platform: repository.platform, fullName }
      : undefined;
  const profileQuery = useEnvironmentProfiles({
    organizationId,
    repository: sandboxRepository,
    selectedProfileId,
  });
  const [initialScript] = useState(() => toEnvironmentScript(existing?.commands ?? []));
  const [script, setScript] = useState(initialScript);
  // Leave existing scripts untouched when saving only variables or the sandbox size.
  const commands = existing && script === initialScript ? undefined : toEnvironmentCommands(script);
  // Retain the baseline shown when editing starts, even if queries refresh in the background.
  const [savedVariables] = useState(() => ({
    plainVars: existing?.plainVars ?? [],
    secretKeys: existing?.secretKeys ?? [],
  }));
  const [variablesText, setVariablesText] = useState(() =>
    formatEnvironmentVariables(savedVariables.plainVars, savedVariables.secretKeys)
  );
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
  const scriptCount = script.trim() ? 1 : 0;
  const isSaving = createEnvironment.isPending || updateEnvironment.isPending;
  const changePage = (next: EditorPage) => {
    setError(null);
    setPage(next);
  };

  const handleSave = async () => {
    if (!variables) {
      setPage('variables');
      return;
    }
    setError(null);
    try {
      validateEnvironmentName(name);
      validateEnvironmentCommands(commands);
      if (existing) {
        await updateEnvironment.mutateAsync({
          organizationId,
          environmentId: existing.id,
          plainVars: variables.plainVars,
          secrets: variables.secrets,
          commands,
          sandboxAllocation,
        });
        onSaved(existing.id);
      } else {
        if (!repository) {
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
          name,
          repository,
          plainVars: variables.plainVars,
          secrets,
          commands,
          sandboxAllocation,
        });
        onSaved(created.id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the environment.');
    }
  };
  const handleDelete = async () => {
    if (!existing) return;
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
              : page === 'variables'
                ? 'Environment variables'
                : existing
                  ? 'Environment'
                  : 'Set up environment'}
          </DialogTitle>
        </div>
        <DialogDescription className="break-all">{fullName}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
        <fieldset disabled={isSaving || deleteEnvironment.isPending} className="min-w-0 space-y-5">
          {page === 'overview' && (
            <>
              {sandboxRepository && (
                <EnvironmentSandboxField
                  organizationId={organizationId}
                  repository={sandboxRepository}
                  value={sandboxAllocation}
                  disabled={isSaving}
                  onChange={setSandboxAllocation}
                />
              )}
              <div className="space-y-3">
                <EditorRow
                  icon={<Terminal className="size-4" />}
                  label="Setup script"
                  detail={
                    scriptCount
                      ? `${scriptCount} ${scriptCount === 1 ? 'script' : 'scripts'}`
                      : 'Install dependencies and prepare your repository'
                  }
                  onClick={() => changePage('scripts')}
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
              <p className="text-muted-foreground text-xs">
                Applies automatically to new sessions in this repository.
              </p>
            </>
          )}
          {page === 'scripts' && <EnvironmentScriptsEditor script={script} onChange={setScript} />}
          {page === 'variables' && (
            <EnvironmentVariablesEditor
              text={variablesText}
              onChange={setVariablesText}
              removedKeys={variables?.removedKeys ?? []}
              error={variablesError}
            />
          )}
        </fieldset>
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
          <>
            {impact.commandProfiles.length > 0 && (
              <p
                role="status"
                className="text-status-warning rounded-md border border-current/20 px-3 py-2 text-xs leading-5"
              >
                {existing
                  ? 'Profile setup commands are skipped'
                  : 'Profile setup commands will not run'}
                : {impact.commandProfiles.join(', ')}.{' '}
                {scriptCount === 0
                  ? 'No setup script will run.'
                  : 'Only the environment scripts will run.'}
              </p>
            )}
            {impact.overrides.length > 0 && (
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
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <DialogFooter className="shrink-0 gap-3 border-t px-6 py-4 sm:items-center sm:justify-between">
        <div>
          {existing && page === 'overview' && (
            <EnvironmentDeleteDialog
              repositoryName={fullName}
              onDelete={handleDelete}
              isDeleting={deleteEnvironment.isPending}
              disabled={isSaving}
            />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={isSaving}>
              Cancel
            </Button>
          </DialogClose>
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
