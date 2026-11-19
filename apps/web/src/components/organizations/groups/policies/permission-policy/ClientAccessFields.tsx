import { FEATURE_VALUES } from '@kilocode/web-shared/lib/feature-detection';
import { Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PolicySelect, type ClientDraft, type ClientPolicy } from './permission-policy-ui';

export function ClientAccessFields({
  draft,
  inherited,
  disabled,
  onChange,
}: {
  draft: ClientDraft;
  inherited?: ClientPolicy['data'];
  disabled: boolean;
  onChange: (draft: ClientDraft) => void;
}) {
  const id = useId();
  const unusedFeatures = FEATURE_VALUES.filter(
    feature => !draft.clients.some(client => client.feature === feature)
  );
  return (
    <div className="grid gap-4">
      <PolicySelect
        label="Client access mode"
        value={draft.mode ?? ''}
        options={[
          { value: '', label: 'Choose an access mode', disabled: true },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'blocklist', label: 'Blocklist' },
        ]}
        disabled={disabled}
        onChange={mode => {
          if (mode)
            onChange({
              ...draft,
              mode,
              clients:
                mode === 'blocklist'
                  ? draft.clients.map(({ feature }) => ({ feature }))
                  : draft.clients,
            });
        }}
      />
      <p className="type-label text-muted-foreground">
        {draft.mode === 'blocklist'
          ? 'A blocklist only blocks the listed products. It does not change any other policy.'
          : 'An allowlist denies unknown and unlisted clients. There is no override.'}
      </p>
      {inherited && (
        <div className="type-label text-muted-foreground grid gap-1 border-l pl-3">
          <p className="text-foreground font-medium">
            Organization default: {inherited.mode === 'allowlist' ? 'Allowlist' : 'Blocklist'}
          </p>
          <p className="break-words">
            {inherited.clients
              .map(
                client =>
                  `${client.feature}${'min_version' in client && client.min_version ? ` (${client.min_version} or newer)` : ''}`
              )
              .join(', ') || 'No clients listed.'}
          </p>
          <p>A client must pass both the organization default and every applicable group policy.</p>
        </div>
      )}
      {draft.mode === 'allowlist' && draft.clients.length === 0 && (
        <p className="type-label text-muted-foreground rounded-md border p-3">
          An empty allowlist blocks every client in this scope.
        </p>
      )}
      {draft.mode && (
        <fieldset disabled={disabled} className="grid min-w-0 gap-3">
          {draft.clients.map((client, index) => (
            <div
              key={index}
              className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
            >
              <PolicySelect
                label={`Client ${index + 1}`}
                value={client.feature ?? ''}
                options={[
                  { value: '', label: 'Choose a product', disabled: true },
                  ...FEATURE_VALUES.filter(
                    feature => feature === client.feature || unusedFeatures.includes(feature)
                  ).map(feature => ({ value: feature, label: feature })),
                ]}
                onChange={feature => {
                  if (!feature) return;
                  onChange({
                    ...draft,
                    clients: draft.clients.map((entry, position) =>
                      position === index ? { ...entry, feature } : entry
                    ),
                  });
                }}
              />
              {draft.mode === 'allowlist' && (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-${index}`}>Minimum version {index + 1}</Label>
                  <Input
                    id={`${id}-${index}`}
                    placeholder="Optional, e.g. 1.2.3"
                    maxLength={100}
                    value={client.min_version ?? ''}
                    onChange={event =>
                      onChange({
                        ...draft,
                        clients: draft.clients.map((entry, position) =>
                          position === index
                            ? { ...entry, min_version: event.target.value || undefined }
                            : entry
                        ),
                      })
                    }
                  />
                </div>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove client ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...draft,
                    clients: draft.clients.filter((_, position) => position !== index),
                  })
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {!disabled && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={
                unusedFeatures.length === 0 || draft.clients.some(client => !client.feature)
              }
              onClick={() => onChange({ ...draft, clients: [...draft.clients, {}] })}
            >
              <Plus className="size-4" /> Add client
            </Button>
          )}
        </fieldset>
      )}
    </div>
  );
}
