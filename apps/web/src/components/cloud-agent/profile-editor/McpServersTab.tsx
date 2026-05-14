/** MCP servers tab for the profile editor. */
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Server,
  Lock,
  AlertTriangle,
  ShieldCheck,
  AlertCircle,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { cn } from '@/lib/utils';
import { MASKED_SECRET_VALUE } from '@kilocode/cloud-agent-profile';
import { useProfileMutations, type ProfileMcpServer } from '@/hooks/useCloudAgentProfiles';
import { MonacoJsonEditor } from '../MonacoJsonEditor';

function countSecretValues(server: ProfileMcpServer): number {
  if (server.type === 'local' && 'command' in server.config) {
    return Object.keys(server.config.environment ?? {}).length;
  }
  if (server.type === 'remote' && 'url' in server.config) {
    return Object.keys(server.config.headers ?? {}).length;
  }
  return 0;
}

type Props = {
  profileId: string;
  organizationId: string | undefined;
  mcpServers: ProfileMcpServer[];
};

export function McpServersTab({ profileId, organizationId, mcpServers }: Props) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-2 p-4">
      <div className="text-muted-foreground bg-muted/50 flex items-start gap-2 rounded-md border border-dashed p-3 text-xs">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>Only add servers you trust. Docker and absolute host paths are not supported.</div>
      </div>

      {mcpServers.map(server =>
        editingId === server.id ? (
          <McpForm
            key={server.id}
            mode="edit"
            initial={server}
            profileId={profileId}
            organizationId={organizationId}
            onDone={() => setEditingId(null)}
          />
        ) : (
          <McpServerRow
            key={server.id}
            server={server}
            profileId={profileId}
            organizationId={organizationId}
            onEdit={() => {
              setEditingId(server.id);
              setIsAdding(false);
            }}
          />
        )
      )}

      {isAdding ? (
        <McpForm
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
          Add MCP server
        </Button>
      )}

      {mcpServers.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No MCP servers yet.</p>
      )}
    </div>
  );
}

function McpServerRow({
  server,
  profileId,
  organizationId,
  onEdit,
}: {
  server: ProfileMcpServer;
  profileId: string;
  organizationId: string | undefined;
  onEdit: () => void;
}) {
  const { deleteMcp } = useProfileMutations({ organizationId });
  const [deleting, setDeleting] = useState(false);

  const summary =
    server.type === 'local' && 'command' in server.config
      ? server.config.command.join(' ')
      : server.type === 'remote' && 'url' in server.config
        ? server.config.url
        : '';

  return (
    <div
      className={cn(
        'hover:bg-accent/50 rounded-lg border p-3 transition-colors',
        !server.enabled && 'opacity-60'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Server className="text-muted-foreground h-4 w-4" />
            <code className="bg-muted rounded px-2 py-0.5 font-mono text-sm">{server.name}</code>
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              {server.type}
            </span>
            {!server.enabled && (
              <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                Disabled
              </span>
            )}
            {countSecretValues(server) > 0 && (
              <span className="text-muted-foreground flex items-center gap-0.5 text-xs">
                <Lock className="h-3 w-3" />
                {countSecretValues(server)}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={onEdit}
            disabled={deleting}
            aria-label="Edit MCP server"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <InlineDeleteConfirmation
            onDelete={async () => {
              setDeleting(true);
              try {
                await deleteMcp.mutateAsync({
                  profileId,
                  organizationId,
                  mcpServerId: server.id,
                });
                toast.success(`MCP server "${server.name}" deleted`);
              } catch (error) {
                console.error('Failed to delete MCP server:', error);
                toast.error('Failed to delete MCP server');
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

// -------------------------------------------------------------------
// McpForm — shared create/edit form
// -------------------------------------------------------------------

type McpFormProps = {
  profileId: string;
  organizationId: string | undefined;
  onDone: () => void;
} & ({ mode: 'create'; initial?: undefined } | { mode: 'edit'; initial: ProfileMcpServer });

type FormState = {
  type: 'local' | 'remote';
  name: string;
  enabled: boolean;
  commandText: string;
  url: string;
  envJson: string;
};

function initialFormState(initial: ProfileMcpServer | undefined): FormState {
  if (!initial) {
    return {
      type: 'local',
      name: '',
      enabled: true,
      commandText: '',
      url: '',
      envJson: '',
    };
  }
  const { type, name, enabled, config } = initial;
  if (type === 'local' && 'command' in config) {
    const env = config.environment ?? {};
    return {
      type,
      name,
      enabled,
      commandText: config.command.join(' '),
      url: '',
      envJson: Object.keys(env).length > 0 ? JSON.stringify(env, null, 2) : '',
    };
  }
  if (type === 'remote' && 'url' in config) {
    const headers = config.headers ?? {};
    return {
      type,
      name,
      enabled,
      commandText: '',
      url: config.url,
      envJson: Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '',
    };
  }
  return { type: 'local', name, enabled, commandText: '', url: '', envJson: '' };
}

/** Parse JSON and validate it's a `Record<string,string>`. */
function parseRecord(raw: string):
  | {
      ok: true;
      value: Record<string, string> | undefined;
    }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object of string → string' };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `Value for "${k}" must be a string` };
    }
    out[k] = v;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

function McpForm(props: McpFormProps) {
  const { profileId, organizationId, onDone, mode } = props;
  const { createMcp, updateMcp } = useProfileMutations({ organizationId });
  const [form, setForm] = useState<FormState>(() =>
    initialFormState(mode === 'edit' ? props.initial : undefined)
  );
  const [saving, setSaving] = useState(false);
  /** Only populated when the user attempts to save with invalid JSON; cleared on edit. */
  const [jsonError, setJsonError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('MCP server name is required');
      return;
    }
    const jsonCheck = parseRecord(form.envJson);
    if (!jsonCheck.ok) {
      setJsonError(jsonCheck.error);
      return;
    }
    setJsonError(null);

    setSaving(true);
    try {
      if (form.type === 'local') {
        const parts = form.commandText
          .split(/\s+/)
          .map(p => p.trim())
          .filter(Boolean);
        if (parts.length === 0) {
          toast.error('Command is required');
          return;
        }
        const payload = {
          profileId,
          organizationId,
          server: {
            type: 'local' as const,
            name: form.name.trim(),
            enabled: form.enabled,
            config: { command: parts, environment: jsonCheck.value },
          },
        };
        if (mode === 'edit') {
          await updateMcp.mutateAsync({ ...payload, mcpServerId: props.initial.id });
        } else {
          await createMcp.mutateAsync(payload);
        }
      } else {
        if (!form.url.trim()) {
          toast.error('URL is required');
          return;
        }
        const payload = {
          profileId,
          organizationId,
          server: {
            type: 'remote' as const,
            name: form.name.trim(),
            enabled: form.enabled,
            config: { url: form.url.trim(), headers: jsonCheck.value },
          },
        };
        if (mode === 'edit') {
          await updateMcp.mutateAsync({ ...payload, mcpServerId: props.initial.id });
        } else {
          await createMcp.mutateAsync(payload);
        }
      }
      toast.success(
        mode === 'edit' ? `MCP server "${form.name}" updated` : `MCP server "${form.name}" added`
      );
      onDone();
    } catch (error) {
      console.error('Failed to save MCP server:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save MCP server');
    } finally {
      setSaving(false);
    }
  };

  const jsonLabel = form.type === 'local' ? 'Environment (JSON)' : 'Headers (JSON)';
  const jsonPlaceholder =
    form.type === 'local' ? '{\n  "API_KEY": "sk-..."\n}' : '{\n  "Authorization": "Bearer ..."\n}';

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      {/* Header row: type toggle (create) / kind label (edit) + enabled switch.
          Type toggle is hidden on edit so envelope preservation is unambiguous. */}
      <div className="flex items-center justify-between gap-2">
        {mode === 'create' ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={form.type === 'local' ? 'default' : 'outline'}
              onClick={() => update('type', 'local')}
              type="button"
            >
              Local
            </Button>
            <Button
              size="sm"
              variant={form.type === 'remote' ? 'default' : 'outline'}
              onClick={() => update('type', 'remote')}
              type="button"
            >
              Remote
            </Button>
          </div>
        ) : (
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Editing {form.type} MCP server
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <span className="text-muted-foreground">{form.enabled ? 'Enabled' : 'Disabled'}</span>
          <Switch
            checked={form.enabled}
            onCheckedChange={checked => update('enabled', checked)}
            disabled={saving}
          />
        </label>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={form.name}
          onChange={e => update('name', e.target.value)}
          placeholder="my-server"
          autoFocus={mode === 'create'}
          disabled={saving}
        />
      </div>

      {form.type === 'local' ? (
        <div className="grid gap-2">
          <Label htmlFor="mcp-command">Command</Label>
          <Input
            id="mcp-command"
            value={form.commandText}
            onChange={e => update('commandText', e.target.value)}
            placeholder="npx @example/mcp-server --flag value"
            className="font-mono"
            disabled={saving}
          />
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="mcp-url">URL</Label>
          <Input
            id="mcp-url"
            value={form.url}
            onChange={e => update('url', e.target.value)}
            placeholder="https://example.com/mcp"
            className="font-mono"
            disabled={saving}
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label>{jsonLabel}</Label>
          {jsonError && (
            <span className="text-destructive flex items-center gap-1 text-[11px]">
              <AlertCircle className="h-3 w-3" />
              {jsonError}
            </span>
          )}
        </div>
        <MonacoJsonEditor
          value={form.envJson}
          onChange={next => {
            update('envJson', next);
            if (jsonError) setJsonError(null);
          }}
          placeholder={jsonPlaceholder}
          height="160px"
        />
        <p className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Values are encrypted at rest (RSA-AES-256-GCM) and decrypted only inside your Cloud
            Agent sandbox — they are never visible to us in plaintext.
            {mode === 'edit' && (
              <>
                {' '}
                Existing values show as{' '}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {MASKED_SECRET_VALUE}
                </code>
                ; leave them to keep the secret, or replace to rotate.
              </>
            )}
          </span>
        </p>
      </div>

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
            'Add MCP server'
          )}
        </Button>
      </div>
    </div>
  );
}
