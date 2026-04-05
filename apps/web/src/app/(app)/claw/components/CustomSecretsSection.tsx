'use client';

import { useState } from 'react';
import { ChevronDown, ExternalLink, Info, Key, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  isValidCustomSecretKey,
  isValidConfigPath,
  MAX_CUSTOM_SECRET_VALUE_LENGTH,
} from '@kilocode/kiloclaw-secret-catalog';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

import { ChannelTokenInput } from './ChannelTokenInput';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

/**
 * Convert a dot-notation config path to a suggested env var name.
 * e.g. "cron.webhookToken" → "CRON_WEBHOOK_TOKEN"
 *      "models.providers.openai.apiKey" → "MODELS_PROVIDERS_OPENAI_API_KEY"
 */
function configPathToEnvVar(path: string): string {
  return path
    .replace(/\./g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

type EditingSecret = {
  /** The env var name being edited (null = adding new) */
  originalName: string | null;
  configPath: string;
  envVarName: string;
  envVarNameTouched: boolean;
  envVarValue: string;
};

const EMPTY_FORM: EditingSecret = {
  originalName: null,
  configPath: '',
  envVarName: '',
  envVarNameTouched: false,
  envVarValue: '',
};

function SecretForm({
  editing,
  isSaving,
  pathError,
  pathCollision,
  nameError,
  nameCollision,
  onConfigPathChange,
  onEnvVarNameChange,
  onValueChange,
  onSave,
  onCancel,
  onRemove,
}: {
  editing: EditingSecret;
  isSaving: boolean;
  pathError: boolean;
  pathCollision: boolean;
  nameError: boolean;
  nameCollision: boolean;
  onConfigPathChange: (value: string) => void;
  onEnvVarNameChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="space-y-3">
      {editing.originalName && (
        <p className="text-muted-foreground text-xs">
          Editing <code className="bg-muted rounded px-1">{editing.originalName}</code> — leave
          value blank to keep the existing value.
        </p>
      )}
      <div>
        <Label htmlFor="custom-secret-config-path" className="mb-1 block text-xs">
          Config Path
        </Label>
        <Input
          id="custom-secret-config-path"
          type="text"
          placeholder="models.providers.openai.apiKey"
          value={editing.configPath}
          onChange={e => onConfigPathChange(e.target.value)}
          disabled={isSaving}
          maxLength={256}
          autoComplete="off"
          className={pathError || pathCollision ? 'border-red-500' : ''}
        />
        {pathError && (
          <p className="mt-1 text-[11px] text-red-400">
            Not a supported credential path.{' '}
            <a
              href="https://docs.openclaw.ai/reference/secretref-credential-surface"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              See supported paths
            </a>
            .
          </p>
        )}
        {pathCollision && (
          <p className="mt-1 text-[11px] text-red-400">
            Another secret already uses this config path.
          </p>
        )}
        <p className="text-muted-foreground mt-1 text-[11px]">
          The JSON path in openclaw.json where this secret will be written.
        </p>
      </div>
      <div>
        <Label htmlFor="custom-secret-value" className="mb-1 block text-xs">
          Value
        </Label>
        <ChannelTokenInput
          id="custom-secret-value"
          placeholder={editing.originalName ? 'Leave blank to keep existing value' : 'sk-...'}
          value={editing.envVarValue}
          onChange={onValueChange}
          disabled={isSaving}
          maxLength={MAX_CUSTOM_SECRET_VALUE_LENGTH}
        />
      </div>
      <div>
        <Label htmlFor="custom-secret-name" className="mb-1 block text-xs">
          Environment Variable Name
        </Label>
        <Input
          id="custom-secret-name"
          type="text"
          placeholder="MY_API_KEY"
          value={editing.envVarName}
          onChange={e => onEnvVarNameChange(e.target.value)}
          disabled={isSaving}
          maxLength={128}
          autoComplete="off"
          className={nameError || nameCollision ? 'border-red-500' : ''}
        />
        {nameError && (
          <p className="mt-1 text-[11px] text-red-400">
            Must be a valid env var name (A-Z, 0-9, _). Cannot use KILOCLAW_ prefix or collide with
            built-in secrets.
          </p>
        )}
        {nameCollision && (
          <p className="mt-1 text-[11px] text-red-400">A secret with this name already exists.</p>
        )}
        <p className="text-muted-foreground mt-1 text-[11px]">
          Also available as this env var in the container.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onSave}
          disabled={
            isSaving ||
            !editing.configPath.trim() ||
            !editing.envVarName.trim() ||
            (!editing.originalName && !editing.envVarValue.trim()) ||
            pathError ||
            pathCollision ||
            nameError ||
            nameCollision
          }
        >
          <Save className="h-4 w-4" />
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
        {onRemove ? (
          <Button variant="outline" size="sm" onClick={onRemove} disabled={isSaving}>
            <Trash2 className="h-4 w-4" />
            Remove
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
            <X className="h-4 w-4" />
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function CustomSecretsSection({
  customSecretKeys,
  customSecretMeta,
  mutations,
  onRedeploy,
}: {
  customSecretKeys: string[];
  customSecretMeta: Record<string, { configPath?: string }>;
  mutations: ClawMutations;
  onRedeploy?: () => void;
}) {
  const [editing, setEditing] = useState<EditingSecret | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const isSaving = mutations.patchSecrets.isPending;

  const pathError = editing
    ? editing.configPath.length > 0 && !isValidConfigPath(editing.configPath)
    : false;
  const nameError = editing
    ? editing.envVarName.length > 0 && !isValidCustomSecretKey(editing.envVarName)
    : false;
  // When editing an existing secret, allow keeping the same env var name
  const nameCollision =
    editing &&
    !nameError &&
    editing.envVarName.length > 0 &&
    customSecretKeys.includes(editing.envVarName) &&
    editing.originalName !== editing.envVarName;
  // Check if another secret already uses this config path
  const pathCollision =
    editing &&
    !pathError &&
    editing.configPath.length > 0 &&
    Object.entries(customSecretMeta).some(
      ([envVar, meta]) => meta.configPath === editing.configPath && envVar !== editing.originalName
    );

  function updateEditing(patch: Partial<EditingSecret>) {
    setEditing(prev => (prev ? { ...prev, ...patch } : null));
  }

  function handleConfigPathChange(value: string) {
    if (!editing) return;
    const patch: Partial<EditingSecret> = { configPath: value };
    if (!editing.envVarNameTouched) {
      const trimmed = value.trim();
      patch.envVarName = trimmed ? configPathToEnvVar(trimmed) : '';
    }
    updateEditing(patch);
  }

  function handleEnvVarNameChange(value: string) {
    updateEditing({ envVarName: value.toUpperCase(), envVarNameTouched: true });
  }

  function startNew() {
    setEditing({ ...EMPTY_FORM });
  }

  function startEdit(name: string) {
    const meta = customSecretMeta[name];
    setEditing({
      originalName: name,
      configPath: meta?.configPath ?? '',
      envVarName: name,
      envVarNameTouched: true,
      envVarValue: '',
    });
  }

  function handleSave() {
    if (!editing) return;

    const path = editing.configPath.trim();
    const name = editing.envVarName.trim();
    const value = editing.envVarValue.trim();
    const isEdit = !!editing.originalName;

    if (!path) {
      toast.error('Config path is required.');
      return;
    }
    if (!isValidConfigPath(path)) {
      toast.error('Invalid config path. Use dot notation like models.providers.openai.apiKey');
      return;
    }
    if (!name) {
      toast.error('Env var name is required.');
      return;
    }
    // Value is required for new secrets, optional for edits (keeps existing value)
    if (!isEdit && !value) {
      toast.error('Value is required.');
      return;
    }
    if (!isValidCustomSecretKey(name)) {
      toast.error('Invalid env var name.');
      return;
    }
    if (nameCollision) {
      toast.error(`Secret "${name}" already exists. Use a different name or edit that secret.`);
      return;
    }

    const isRename = editing.originalName && editing.originalName !== name;
    const secrets: Record<string, string | null> = {};

    // Only include value in the patch if the user entered one.
    // For edits with no value change, we still need to include the key
    // if renaming (so the new name gets the value). For metadata-only
    // updates (same name, no new value), we send an empty secrets object
    // and rely on the meta update alone.
    if (value) {
      secrets[name] = value;
    }
    if (isRename && editing.originalName) {
      secrets[editing.originalName] = null;
      // If no new value provided during rename, we need to re-set the secret
      // under the new name. But we don't have the old value — the user must
      // provide it. Show an error.
      if (!value) {
        toast.error('Value is required when changing the env var name.');
        return;
      }
    }

    // Always send meta to update config path
    const meta = { [name]: { configPath: path } };

    // If nothing changed (same name, same path, no new value), skip
    if (
      isEdit &&
      !value &&
      !isRename &&
      editing.configPath === (customSecretMeta[name]?.configPath ?? '')
    ) {
      toast.info('No changes to save.');
      setEditing(null);
      return;
    }

    mutations.patchSecrets.mutate(
      { secrets, meta },
      {
        onSuccess: () => {
          toast.success(`Secret "${path}" ${isEdit ? 'updated' : 'saved'}. Redeploy to apply.`, {
            duration: 8000,
            ...(onRedeploy && {
              action: { label: 'Redeploy', onClick: onRedeploy },
            }),
          });
          setEditing(null);
        },
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  function handleRemove(name: string) {
    mutations.patchSecrets.mutate(
      { secrets: { [name]: null } },
      {
        onSuccess: () => {
          toast.success(`Secret removed. Redeploy to apply.`, {
            duration: 8000,
            ...(onRedeploy && {
              action: { label: 'Redeploy', onClick: onRedeploy },
            }),
          });
          // Close form if we were editing the deleted secret
          if (editing?.originalName === name) setEditing(null);
        },
        onError: err => toast.error(`Failed to remove: ${err.message}`),
      }
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-foreground text-base font-semibold">Additional Secrets</h2>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] leading-4">
          {customSecretKeys.length} secret{customSecretKeys.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      <div className="space-y-3">
        {/* Help info */}
        <Collapsible open={helpOpen} onOpenChange={setHelpOpen}>
          <div className="rounded-lg border">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
              >
                <Info className="text-muted-foreground h-4 w-4 shrink-0" />
                <span className="text-muted-foreground text-xs">
                  Add encrypted secrets that are patched into your openclaw.json config.
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Separator />
              <div className="space-y-2 px-4 py-3 text-xs">
                <p className="text-muted-foreground">
                  Specify a <strong>Config Path</strong> (JSON dot notation) and the secret value
                  will be automatically written to that location in your{' '}
                  <code className="bg-muted rounded px-1">openclaw.json</code> on every boot.
                </p>
                <p className="text-muted-foreground">
                  The secret is also available as an environment variable in the container. See{' '}
                  <a
                    href="https://docs.openclaw.ai/reference/secretref-credential-surface"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 underline"
                  >
                    supported credential paths
                    <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  for common paths.
                </p>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Add button / New secret form — always at top */}
        {editing && !editing.originalName ? (
          <div className="rounded-lg border px-4 py-3">
            <SecretForm
              editing={editing}
              isSaving={isSaving}
              pathError={pathError}
              pathCollision={!!pathCollision}
              nameError={nameError}
              nameCollision={!!nameCollision}
              onConfigPathChange={handleConfigPathChange}
              onEnvVarNameChange={handleEnvVarNameChange}
              onValueChange={v => updateEditing({ envVarValue: v })}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={startNew}
            disabled={isSaving}
            className="w-full"
          >
            <Plus className="h-4 w-4" />
            Add Secret
          </Button>
        )}

        {/* Existing secrets list — newest first */}
        {[...customSecretKeys].reverse().map(name => {
          const meta = customSecretMeta[name];
          const isBeingEdited = editing?.originalName === name;
          return (
            <div key={name} className="rounded-lg border">
              <button
                type="button"
                onClick={() => (isBeingEdited ? setEditing(null) : startEdit(name))}
                disabled={isSaving}
                className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
              >
                <Key className="text-muted-foreground h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1 text-left">
                  {meta?.configPath ? (
                    <>
                      <span className="block truncate text-sm font-medium">{meta.configPath}</span>
                      <span className="text-muted-foreground text-xs">env: {name}</span>
                    </>
                  ) : (
                    <span className="block truncate text-sm font-medium">{name}</span>
                  )}
                </div>
                <ChevronDown
                  className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 ${isBeingEdited ? 'rotate-180' : ''}`}
                />
              </button>
              {/* Inline edit form */}
              {isBeingEdited && editing && (
                <>
                  <Separator />
                  <div className="px-4 py-3">
                    <SecretForm
                      editing={editing}
                      isSaving={isSaving}
                      pathError={pathError}
                      pathCollision={!!pathCollision}
                      nameError={nameError}
                      nameCollision={!!nameCollision}
                      onConfigPathChange={handleConfigPathChange}
                      onEnvVarNameChange={handleEnvVarNameChange}
                      onValueChange={v => updateEditing({ envVarValue: v })}
                      onSave={handleSave}
                      onCancel={() => setEditing(null)}
                      onRemove={() => handleRemove(name)}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
