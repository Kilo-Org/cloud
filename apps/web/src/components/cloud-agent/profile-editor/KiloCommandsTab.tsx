/** Kilo commands tab for the profile editor. */
'use client';

import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Terminal, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { cn } from '@/lib/utils';
import { useProfileMutations, type ProfileKiloCommand } from '@/hooks/useCloudAgentProfiles';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import {
  MAX_KILO_COMMAND_NAME_LENGTH,
  MAX_KILO_COMMAND_TEMPLATE_LENGTH,
  MAX_KILO_COMMAND_DESCRIPTION_LENGTH,
} from '@kilocode/cloud-agent-profile';

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

type Props = {
  profileId: string;
  organizationId: string | undefined;
  kiloCommands: ProfileKiloCommand[];
};

export function KiloCommandsTab({ profileId, organizationId, kiloCommands }: Props) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-2 p-4">
      {kiloCommands.map(cmd =>
        editingId === cmd.id ? (
          <KiloCommandForm
            key={cmd.id}
            mode="edit"
            initial={cmd}
            profileId={profileId}
            organizationId={organizationId}
            onDone={() => setEditingId(null)}
          />
        ) : (
          <KiloCommandRow
            key={cmd.id}
            command={cmd}
            profileId={profileId}
            organizationId={organizationId}
            onEdit={() => {
              setEditingId(cmd.id);
              setIsAdding(false);
            }}
          />
        )
      )}

      {isAdding ? (
        <KiloCommandForm
          mode="create"
          profileId={profileId}
          organizationId={organizationId}
          onDone={() => setIsAdding(false)}
        />
      ) : (
        <Button
          variant="outline"
          className="h-11 w-full border-dashed"
          onClick={() => {
            setIsAdding(true);
            setEditingId(null);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add command
        </Button>
      )}

      {kiloCommands.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No custom commands yet.</p>
      )}
    </div>
  );
}

function KiloCommandRow({
  command,
  profileId,
  organizationId,
  onEdit,
}: {
  command: ProfileKiloCommand;
  profileId: string;
  organizationId: string | undefined;
  onEdit: () => void;
}) {
  const { deleteKiloCommand } = useProfileMutations({ organizationId });
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="hover:bg-accent/50 rounded-lg border p-3 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Terminal className="text-muted-foreground h-4 w-4" />
            <code className="bg-muted rounded px-2 py-0.5 font-mono text-sm">/{command.name}</code>
            {command.subtask && (
              <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                Subtask
              </span>
            )}
            {command.agent && (
              <span className="text-muted-foreground text-xs">agent: {command.agent}</span>
            )}
            {command.model && (
              <span className="text-muted-foreground text-xs">model: {command.model}</span>
            )}
          </div>
          {command.description && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
              {command.description}
            </p>
          )}
          <p className="text-muted-foreground mt-0.5 line-clamp-1 font-mono text-xs">
            {command.template}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={onEdit}
            disabled={deleting}
            aria-label="Edit command"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <InlineDeleteConfirmation
            onDelete={async () => {
              setDeleting(true);
              try {
                await deleteKiloCommand.mutateAsync({
                  profileId,
                  organizationId,
                  commandId: command.id,
                });
                toast.success(`Command "/${command.name}" deleted`);
              } catch (error) {
                console.error('Failed to delete command:', error);
                toast.error('Failed to delete command');
              } finally {
                setDeleting(false);
              }
            }}
            isLoading={deleting}
          />
        </div>
      </div>
    </div>
  );
}

type FormState = {
  name: string;
  description: string;
  template: string;
  agent: string;
  model: string;
  subtask: boolean;
};

type KiloCommandFormProps = {
  profileId: string;
  organizationId: string | undefined;
  onDone: () => void;
} & ({ mode: 'create'; initial?: undefined } | { mode: 'edit'; initial: ProfileKiloCommand });

function KiloCommandForm(props: KiloCommandFormProps) {
  const { profileId, organizationId, onDone, mode } = props;
  const { createKiloCommand, updateKiloCommand } = useProfileMutations({ organizationId });
  const { data: modelsData } = useModelSelectorList(organizationId);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data ?? []).map(m => ({
        id: m.id,
        name: m.name,
        isFree: m.isFree,
        variants: m.opencode?.variants ? Object.keys(m.opencode.variants) : undefined,
      })),
    [modelsData]
  );
  const [form, setForm] = useState<FormState>(() =>
    mode === 'edit'
      ? {
          name: props.initial.name,
          description: props.initial.description ?? '',
          template: props.initial.template,
          agent: props.initial.agent ?? '',
          model: props.initial.model ?? '',
          subtask: props.initial.subtask,
        }
      : { name: '', description: '', template: '', agent: '', model: '', subtask: false }
  );
  const [saving, setSaving] = useState(false);

  const nameValid = COMMAND_NAME_PATTERN.test(form.name);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Command name is required');
      return;
    }
    if (!nameValid) {
      toast.error(
        'Name must start with a lowercase letter and contain only lowercase letters, digits, and dashes'
      );
      return;
    }
    if (!form.template.trim()) {
      toast.error('Template is required');
      return;
    }
    if (form.template.length > MAX_KILO_COMMAND_TEMPLATE_LENGTH) {
      toast.error(`Template exceeds ${MAX_KILO_COMMAND_TEMPLATE_LENGTH} characters`);
      return;
    }
    if (form.description.length > MAX_KILO_COMMAND_DESCRIPTION_LENGTH) {
      toast.error(`Description exceeds ${MAX_KILO_COMMAND_DESCRIPTION_LENGTH} characters`);
      return;
    }

    setSaving(true);
    try {
      // Create: send undefined for optional fields so the DB default applies.
      // Update: send null for nullable fields to explicitly clear them.
      // subtask is always sent as a boolean (never undefined) so the user's
      // choice is persisted rather than silently falling back to the default.
      const payload = {
        profileId,
        organizationId,
        name: form.name,
        template: form.template,
        subtask: form.subtask,
      };

      if (mode === 'edit') {
        await updateKiloCommand.mutateAsync({
          ...payload,
          commandId: props.initial.id,
          description: form.description || null,
          agent: form.agent || null,
          model: form.model || null,
        });
        toast.success(`Command "/${form.name}" updated`);
      } else {
        await createKiloCommand.mutateAsync({
          ...payload,
          description: form.description || undefined,
          agent: form.agent || undefined,
          model: form.model || undefined,
        });
        toast.success(`Command "/${form.name}" added`);
      }
      onDone();
    } catch (error) {
      console.error('Failed to save command:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save command');
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      {mode === 'edit' && (
        <div className="text-muted-foreground text-xs uppercase tracking-wide">Editing command</div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="kilo-command-name">Name</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">/</span>
          <Input
            id="kilo-command-name"
            value={form.name}
            onChange={e => update('name', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="my-command"
            autoFocus={mode === 'create'}
            disabled={saving}
            className={cn('font-mono', !nameValid && form.name && 'border-destructive')}
            maxLength={MAX_KILO_COMMAND_NAME_LENGTH}
          />
          <span
            className={cn(
              'text-xs',
              nameValid || !form.name ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {form.name ? (nameValid ? 'Valid' : 'Invalid') : ''}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">
          Lowercase letters, digits, and dashes. Must start with a letter.
        </span>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="kilo-command-description">Description (optional)</Label>
        <Input
          id="kilo-command-description"
          value={form.description}
          onChange={e => update('description', e.target.value)}
          placeholder="Shown in command autocomplete"
          disabled={saving}
          maxLength={MAX_KILO_COMMAND_DESCRIPTION_LENGTH}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="kilo-command-template">Template</Label>
        <Textarea
          id="kilo-command-template"
          value={form.template}
          onChange={e => update('template', e.target.value)}
          rows={8}
          className="font-mono text-xs"
          placeholder="Analyze the code in $ARGUMENTS and suggest improvements..."
          disabled={saving}
        />
        <span className="text-muted-foreground text-xs">Use $ARGUMENTS, $1, $2 for user input</span>
      </div>

      <div className="grid grid-cols-2 items-start gap-2">
        <div className="grid gap-2">
          <Label htmlFor="kilo-command-agent">Agent (optional)</Label>
          <Input
            id="kilo-command-agent"
            value={form.agent}
            onChange={e => update('agent', e.target.value)}
            placeholder="e.g. code, architect"
            disabled={saving}
          />
        </div>
        <div className="grid gap-2">
          <Label>Model (optional)</Label>
          <ModelCombobox
            label=""
            models={modelOptions}
            value={form.model || undefined}
            onValueChange={v => update('model', v)}
            isLoading={!modelsData}
            placeholder="Use session default"
            variant="compact"
            className="text-sm"
            modal
            disabled={saving}
          />
          <button
            type="button"
            className={cn(
              'text-muted-foreground hover:text-foreground w-fit text-xs underline',
              !form.model && 'invisible'
            )}
            onClick={() => update('model', '')}
            tabIndex={form.model ? undefined : -1}
          >
            Clear model override
          </button>
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Switch
          checked={form.subtask}
          onCheckedChange={checked => update('subtask', checked)}
          disabled={saving}
        />
        <span className="text-muted-foreground">Run as subtask</span>
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === 'edit' ? (
            'Save changes'
          ) : (
            'Add command'
          )}
        </Button>
      </div>
    </div>
  );
}
