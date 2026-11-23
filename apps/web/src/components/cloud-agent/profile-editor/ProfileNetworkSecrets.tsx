'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  networkSecretAddError,
  parseNetworkSecretForm,
} from '@/components/cloud-agent-next/network-secrets-form';
import type {
  ProfileVar,
  useProfileMutations,
  useCombinedProfileMutations,
} from '@/hooks/useCloudAgentProfiles';
import { NetworkSecretFlow } from './NetworkSecretFlow';

type ProfileMutations =
  | ReturnType<typeof useProfileMutations>
  | ReturnType<typeof useCombinedProfileMutations>;

type NetworkSecretMutations = {
  [Key in 'deleteVar' | 'setVar']: Pick<ProfileMutations[Key], 'mutateAsync'>;
};

type SecretForm = { mode: 'add' | 'edit'; key: string; secret: string; domains: string };

export function ProfileNetworkSecrets({
  profileId,
  organizationId,
  vars,
  mutations,
  readOnly,
}: {
  profileId: string;
  organizationId?: string;
  vars: ProfileVar[];
  mutations: NetworkSecretMutations;
  readOnly: boolean;
}) {
  const id = useId();
  const rows = vars.filter(row => row.delivery === 'network');
  const [form, setForm] = useState<SecretForm | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const busy = saving || deletingKey !== null;

  const openForm = (next: SecretForm) => {
    setForm(next);
    setShowValue(false);
    setError(null);
  };

  const updateForm = (field: 'key' | 'secret' | 'domains', value: string) => {
    setForm(current => current && { ...current, [field]: value });
    setError(null);
  };

  const save = async () => {
    if (!form || busy || readOnly) return;
    const parsed = parseNetworkSecretForm(form);
    if (typeof parsed === 'string') {
      setError(parsed);
      return;
    }
    const { key, value, allowedHosts, locations } = parsed;
    const adding = form.mode === 'add';
    const addError = adding ? networkSecretAddError(vars, key) : null;
    if (addError) {
      setError(addError);
      return;
    }
    setSaving(true);
    try {
      await mutations.setVar.mutateAsync({
        profileId,
        organizationId,
        key,
        value,
        isSecret: true,
        networkSecret: { allowedHosts, locations },
      });
      toast.success(`Network secret "${key}" ${adding ? 'added' : 'updated'}`);
      setForm(null);
    } catch {
      toast.error(adding ? 'Failed to add network secret' : 'Failed to update network secret');
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (key: string) => {
    if (busy || readOnly) return;
    setDeletingKey(key);
    try {
      await mutations.deleteVar.mutateAsync({ profileId, organizationId, key });
      toast.success(`Network secret "${key}" deleted`);
    } catch {
      toast.error('Failed to delete network secret');
    } finally {
      setDeletingKey(null);
    }
  };

  const adding = form?.mode === 'add' && !readOnly;
  const formFields = form && !readOnly && (
    <div className={adding ? 'grid gap-2 @lg:grid-cols-[11rem_minmax(0,1fr)]' : 'grid gap-2'}>
      {form.mode === 'add' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-key`} className="text-xs">
            Variable name
          </Label>
          <Input
            id={`${id}-key`}
            type="text"
            value={form.key}
            onChange={event => updateForm('key', event.target.value)}
            placeholder="API_KEY"
            className="h-8 font-mono text-sm pointer-coarse:h-11"
            disabled={busy}
          />
        </div>
      ) : (
        <code className="bg-muted w-fit rounded px-2 py-0.5 font-mono text-xs break-all">
          {form.key}
        </code>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-value`} className="text-xs">
          Value
        </Label>
        <div className="relative">
          <Input
            id={`${id}-value`}
            type={showValue ? 'text' : 'password'}
            value={form.secret}
            onChange={event => updateForm('secret', event.target.value)}
            placeholder={form.mode === 'edit' ? 'Enter new hidden value' : 'Hidden value'}
            className="h-8 pr-10 text-sm pointer-coarse:h-11"
            autoComplete="new-password"
            data-1p-ignore="true"
            data-form-type="other"
            disabled={busy}
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground absolute top-1/2 right-0 -translate-y-1/2"
            aria-label={showValue ? 'Hide value' : 'Show value'}
            onClick={() => setShowValue(!showValue)}
            disabled={busy}
          >
            {showValue ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </div>
      <div className="col-span-full space-y-1.5">
        <Label htmlFor={`${id}-domains`} className="text-xs">
          Allowed domains
        </Label>
        <Input
          id={`${id}-domains`}
          type="text"
          value={form.domains}
          onChange={event => updateForm('domains', event.target.value)}
          placeholder="sentry.io, us.sentry.io"
          className="h-8 text-sm pointer-coarse:h-11"
          disabled={busy}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive col-span-full text-xs">
          {error}
        </p>
      )}
      <div className="col-span-full flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setForm(null)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={busy}
          aria-label={saving ? 'Saving…' : undefined}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );

  return (
    <section aria-labelledby={id} className="@container space-y-2 border-t pt-4">
      <h3 id={id} className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound aria-hidden="true" className="text-muted-foreground h-3.5 w-3.5" />
        Network secrets
      </h3>
      <NetworkSecretFlow />
      {rows.map(row => (
        <div key={row.key} className="hover:bg-accent/50 rounded-lg border p-2 transition-colors">
          {form?.mode === 'edit' && form.key === row.key && !readOnly ? (
            formFields
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs break-all">
                  {row.key}
                </code>
                <span
                  className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
                  aria-label="Hidden value"
                >
                  <Lock aria-hidden="true" className="h-3 w-3" />
                  <span aria-hidden="true">•••••••</span>
                </span>
                <span className="text-muted-foreground text-xs break-all">
                  {row.allowedHosts?.join(', ')}
                </span>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 pointer-coarse:h-11"
                    onClick={() =>
                      openForm({
                        mode: 'edit',
                        key: row.key,
                        secret: '',
                        domains: row.allowedHosts?.join(', ') ?? '',
                      })
                    }
                    disabled={busy || form !== null}
                  >
                    Edit
                  </Button>
                  <InlineDeleteConfirmation
                    showAsButton
                    className="[&_svg]:mr-0"
                    onDelete={() => deleteRow(row.key)}
                    isLoading={deletingKey === row.key}
                    disabled={busy || form !== null}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {!readOnly &&
        (adding ? (
          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <p className="text-xs font-medium">New network secret</p>
            {formFields}
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full border-dashed"
            onClick={() => openForm({ mode: 'add', key: '', secret: '', domains: '' })}
            disabled={busy || form !== null}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add network secret
          </Button>
        ))}
      {rows.length === 0 && !adding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No network secrets.</p>
      )}
      <p className="text-muted-foreground text-xs">Changes apply to new workspaces.</p>
      <details className="text-muted-foreground text-xs leading-5">
        <summary className="text-foreground cursor-pointer font-medium">Limits</summary>
        <ul className="list-disc space-y-1 pt-1 pl-4">
          <li>Works in Cloudflare sandboxes.</li>
          <li>
            The agent can do anything the key allows on these domains. Use a key with the smallest
            scope.
          </li>
          <li>These domains become reachable when network access is restricted.</li>
          <li>A service that echoes request headers can return the value.</li>
          <li>Clients that check the token format can fail.</li>
          <li>
            In saved files such as <code>.npmrc</code>, reference the variable, for example{' '}
            <code>{'${NPM_TOKEN}'}</code>.
          </li>
          <li>Available in workspace start scripts and agent commands.</li>
          <li>
            Existing workspaces keep the earlier values. To revoke a key, revoke it with its
            provider.
          </li>
        </ul>
      </details>
    </section>
  );
}
