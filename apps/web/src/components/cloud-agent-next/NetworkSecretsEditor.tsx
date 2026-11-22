'use client';

import { useId, useState } from 'react';
import {
  networkSecretInputSchema,
  NETWORK_SECRET_LIMITS,
} from '@kilocode/worker-utils/network-secrets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  emptyNetworkSecretForm,
  hasPendingNetworkSecret,
  type NetworkSecretDraft,
  type NetworkSecretFormState,
} from './network-secrets-form';

export function NetworkSecretsEditor({
  value,
  onChange,
  form,
  onFormChange,
  source,
  readOnly = false,
}: {
  value: NetworkSecretDraft[];
  onChange: (value: NetworkSecretDraft[]) => void;
  form: NetworkSecretFormState;
  onFormChange: (value: NetworkSecretFormState) => void;
  source: 'environment' | 'profile';
  readOnly?: boolean;
}) {
  const id = useId();
  const { key, secret, domains, replacing } = form;
  const pending = hasPendingNetworkSecret(form);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const parsed = networkSecretInputSchema.safeParse({
      key,
      value: secret,
      allowedHosts: domains.split(/[\s,]+/).filter(Boolean),
      locations: ['header'],
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the network secret.');
      return;
    }
    if (!replacing && value.some(row => row.key === key)) {
      setError('This variable name already exists.');
      return;
    }
    if (!replacing && value.length >= NETWORK_SECRET_LIMITS.MAX_SECRETS) {
      setError(`Maximum ${NETWORK_SECRET_LIMITS.MAX_SECRETS} network secrets allowed.`);
      return;
    }
    onChange([...value.filter(row => row.key !== key), parsed.data]);
    onFormChange(emptyNetworkSecretForm);
    setError(null);
  };
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs leading-5">
        Kilo adds each secret to requests for the domains you choose. Commands see a placeholder,
        not the value.
      </p>
      {value.map(row => (
        <div key={row.key} className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="break-all text-xs">{row.key}</code>
            {!readOnly && (
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onFormChange({
                      key: row.key,
                      secret: '',
                      domains: row.allowedHosts.join(', '),
                      replacing: true,
                    });
                  }}
                >
                  Replace value
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(value.filter(candidate => candidate.key !== row.key))}
                >
                  Delete
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {row.allowedHosts.map(host => (
              <Badge key={host} variant="secondary" className="break-all">
                {host}
              </Badge>
            ))}
          </div>
        </div>
      ))}
      {!readOnly && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-key`}>Variable name</Label>
          <Input
            id={`${id}-key`}
            value={key}
            readOnly={replacing}
            onChange={event => onFormChange({ ...form, key: event.target.value })}
            placeholder="SENTRY_AUTH_TOKEN"
            aria-describedby={`${id}-key-help`}
          />
          <p id={`${id}-key-help`} className="text-muted-foreground text-xs">
            Commands read this variable. It holds a placeholder.
          </p>
          <Label htmlFor={`${id}-value`}>Value</Label>
          <Input
            id={`${id}-value`}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={event => onFormChange({ ...form, secret: event.target.value })}
          />
          <Label htmlFor={`${id}-hosts`}>Allowed domains</Label>
          <Input
            id={`${id}-hosts`}
            value={domains}
            onChange={event => onFormChange({ ...form, domains: event.target.value })}
            placeholder="sentry.io, us.sentry.io"
            aria-describedby={`${id}-hosts-help`}
          />
          <p id={`${id}-hosts-help`} className="text-muted-foreground text-xs leading-5">
            Separate domains with commas. Kilo sends the value only to these domains. A request that
            sends it to another domain is blocked.
          </p>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={save}>
              {replacing ? 'Replace network secret' : 'Add network secret'}
            </Button>
            {pending && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onFormChange(emptyNetworkSecretForm);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          {pending && (
            <p role="status" className="text-muted-foreground text-xs">
              Add this network secret or cancel it before saving.
            </p>
          )}
        </div>
      )}
      <p className="text-muted-foreground text-xs leading-5">
        The agent can do anything this key allows on these domains. Use a key with the smallest
        scope.
      </p>
      <p className="text-muted-foreground text-xs leading-5">
        Works in Cloudflare sandboxes. These domains become reachable when network access is
        restricted. Changes and deletions apply to new workspaces. Existing workspaces keep the
        earlier values until you delete them. To revoke a key, revoke it with its provider.
      </p>
      <p className="text-muted-foreground text-xs leading-5">
        {source === 'environment'
          ? 'Available in Cloudflare snapshot build scripts, workspace start scripts, and agent commands.'
          : 'Available in workspace start scripts and agent commands.'}
      </p>
      <p className="text-muted-foreground text-xs leading-5">
        In saved files such as .npmrc, reference the variable, for example{' '}
        <code>{'${NPM_TOKEN}'}</code>.
        {source === 'environment' && ' Expanded build placeholders expire.'}
      </p>
      <p className="text-muted-foreground text-xs leading-5">
        A service can return the value in its response. Do not use services that echo request
        headers. Clients that check token formats can fail.
      </p>
    </div>
  );
}
