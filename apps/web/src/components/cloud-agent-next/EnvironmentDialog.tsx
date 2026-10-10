'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { ENVIRONMENT_LIMITS } from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  useCloudAgentEnvironment,
  useCloudAgentEnvironmentMutations,
  type EnvironmentRepository,
  type EnvironmentResponse,
} from '@/hooks/useCloudAgentEnvironments';
import {
  toEnvironmentCommands,
  toEnvironmentPlainVars,
  toEnvironmentSecretChanges,
  toEnvironmentSecretsRecord,
  validateEnvironmentForm,
  type EnvironmentPlainVarDraft,
  type EnvironmentSecretDraft,
} from './environment-form';
import { EnvironmentSecretsEditor } from './EnvironmentSecretsEditor';

type EnvironmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
  repositoryLabel?: string;
  /** null creates a new environment; an id edits an existing one. */
  environmentId: string | null;
  onSaved: (environmentId: string) => void;
  onDeleted: () => void;
};

export function EnvironmentDialog({
  open,
  onOpenChange,
  organizationId,
  repository,
  repositoryLabel,
  environmentId,
  onSaved,
  onDeleted,
}: EnvironmentDialogProps) {
  const detailQuery = useCloudAgentEnvironment(environmentId, { organizationId, enabled: open });
  const isLoading = !!environmentId && detailQuery.isLoading;
  const isError =
    !!environmentId && (detailQuery.isError || (!detailQuery.isLoading && !detailQuery.data));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{environmentId ? 'Edit environment' : 'Create environment'}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError ? (
          <p className="text-destructive py-6 text-sm">Could not load this environment.</p>
        ) : (
          <EnvironmentForm
            key={environmentId ?? 'new'}
            organizationId={organizationId}
            repository={repository}
            repositoryLabel={repositoryLabel}
            existing={detailQuery.data}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type EnvironmentFormProps = {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
  repositoryLabel?: string;
  existing: EnvironmentResponse | undefined;
  onSaved: (environmentId: string) => void;
  onDeleted: () => void;
};

function EnvironmentForm({
  organizationId,
  repository,
  repositoryLabel,
  existing,
  onSaved,
  onDeleted,
}: EnvironmentFormProps) {
  const { createEnvironment, updateEnvironment, deleteEnvironment } =
    useCloudAgentEnvironmentMutations();
  const [name, setName] = useState(existing?.name ?? '');
  const [plainVars, setPlainVars] = useState<EnvironmentPlainVarDraft[]>(() =>
    existing && existing.plainVars.length > 0
      ? existing.plainVars.map(variable => ({ key: variable.key, value: variable.value }))
      : [{ key: '', value: '' }]
  );
  const [secrets, setSecrets] = useState<EnvironmentSecretDraft[]>(() =>
    (existing?.secretKeys ?? []).map(key => ({ key, value: '', existing: true, deleted: false }))
  );
  const [commands, setCommands] = useState<string[]>(() => existing?.commands ?? []);
  const [error, setError] = useState<string | null>(null);

  const isSaving = createEnvironment.isPending || updateEnvironment.isPending;

  const handleSave = async () => {
    const validationError = validateEnvironmentForm({ name, plainVars, secrets, commands });
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    try {
      if (existing) {
        await updateEnvironment.mutateAsync({
          organizationId,
          environmentId: existing.id,
          name: name.trim(),
          plainVars: toEnvironmentPlainVars(plainVars),
          secrets: toEnvironmentSecretChanges(secrets),
          commands: toEnvironmentCommands(commands),
        });
        onSaved(existing.id);
        return;
      }
      if (!repository) {
        setError('Select a repository first.');
        return;
      }
      const created = await createEnvironment.mutateAsync({
        organizationId,
        name: name.trim(),
        repository,
        plainVars: toEnvironmentPlainVars(plainVars),
        secrets: toEnvironmentSecretsRecord(secrets),
        commands: toEnvironmentCommands(commands),
      });
      onSaved(created.id);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Could not save the environment.');
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    try {
      await deleteEnvironment.mutateAsync({ organizationId, environmentId: existing.id });
      toast.success(`Environment "${existing.name}" deleted`);
      onDeleted();
    } catch {
      toast.error('Failed to delete environment');
    }
  };

  return (
    <div className="space-y-4">
      {!existing && repositoryLabel && (
        <p className="text-muted-foreground text-xs">For {repositoryLabel}</p>
      )}

      <div className="grid gap-2">
        <Label htmlFor="environment-name">Name</Label>
        <Input
          id="environment-name"
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder="e.g. Database and migrations"
          autoFocus
        />
      </div>

      <div className="grid gap-2">
        <Label className="text-xs">Setup commands</Label>
        {commands.map((command, index) => (
          <div key={index} className="flex items-start gap-2">
            <span className="text-muted-foreground w-5 pt-2 text-right font-mono text-xs">
              {index + 1}.
            </span>
            <Textarea
              value={command}
              onChange={event =>
                setCommands(commands.map((row, i) => (i === index ? event.target.value : row)))
              }
              rows={1}
              placeholder="pnpm install"
              className="min-h-8 text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-8 w-8 shrink-0"
              title="Remove command"
              onClick={() => setCommands(commands.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {commands.length < ENVIRONMENT_LIMITS.MAX_COMMANDS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setCommands([...commands, ''])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add command
          </Button>
        )}
      </div>

      <div className="grid gap-2">
        <Label className="text-xs">Variables</Label>
        {plainVars.map((variable, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={variable.key}
              onChange={event =>
                setPlainVars(
                  plainVars.map((row, i) =>
                    i === index ? { ...row, key: event.target.value } : row
                  )
                )
              }
              placeholder="KEY"
              className="h-8 w-44 shrink-0 font-mono text-sm"
              autoComplete="off"
            />
            <Input
              value={variable.value}
              onChange={event =>
                setPlainVars(
                  plainVars.map((row, i) =>
                    i === index ? { ...row, value: event.target.value } : row
                  )
                )
              }
              placeholder="Value"
              className="h-8 flex-1 text-sm"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
              title="Remove variable"
              onClick={() => setPlainVars(plainVars.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setPlainVars([...plainVars, { key: '', value: '' }])}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add variable
        </Button>
      </div>

      <EnvironmentSecretsEditor secrets={secrets} onChange={setSecrets} />

      <div className="text-muted-foreground space-y-1 text-xs">
        <p>
          Setup commands run with the final merged environment, so a profile or inline variable can
          override a variable a script uses.
        </p>
        <p>
          Plaintext values are limited to {ENVIRONMENT_LIMITS.MAX_PLAINTEXT_VALUE_LENGTH}{' '}
          characters. Longer values, such as connection strings, must be secrets.
        </p>
        <p>HOME, XDG_*, KILO*, and OPENCODE* will not arrive as entered.</p>
        <p>
          Setup output and automatic Git diagnostics hide secret values, but agent output and
          terminals do not.
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <DialogFooter className="sm:justify-between">
        <div>
          {existing && (
            <InlineDeleteConfirmation
              onDelete={handleDelete}
              isLoading={deleteEnvironment.isPending}
              showAsButton
              buttonText="Delete environment"
              warningText="Permanently removes this environment, its commands, variables, and secrets. This cannot be undone."
            />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={isSaving}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save environment'}
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}
