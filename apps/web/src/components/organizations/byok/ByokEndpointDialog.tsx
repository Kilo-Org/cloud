'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, Info, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  BYOK_ENDPOINT_MAX_MODELS,
  BYOK_ENDPOINT_MODEL_PLACEHOLDER,
  type ByokEndpointDefinition,
  type ByokEndpointModel,
  type ByokEndpointReasoningFormat,
  type CustomLlmApiKind,
  type CustomLlmProvider,
} from '@kilocode/db/schema-types';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  EMPTY_ENDPOINT_CREDENTIALS_FORM,
  ENDPOINT_API_KINDS,
  ENDPOINT_API_KIND_LABELS,
  ENDPOINT_CLIENT_PROVIDER_LABELS,
  ENDPOINT_CREDENTIALS_TYPE_LABELS,
  ENDPOINT_REASONING_FORMAT_LABELS,
  buildEndpointCredentials,
  buildEndpointDefinition,
  mergeImportedModels,
  setEndpointModelFlag,
  toEndpointForm,
  toEndpointModelRow,
  type ByokEndpointCredentialsType,
  type EndpointCredentialsForm,
  type EndpointForm,
  type EndpointModelRow,
} from '@/lib/byok/endpoint-form';
import { endpointOriginChanged } from '@/lib/byok/endpoint-origin';
import { ByokEndpointImportDialog } from './ByokEndpointImportDialog';
import {
  useEndpointCatalogModelIds,
  type EndpointCatalogModelIds,
} from './useEndpointCatalogModelIds';

export type ByokEndpointDialogKey = {
  id: string;
  endpoint: ByokEndpointDefinition | null;
  serve_catalog_models: boolean;
};

const INHERIT = 'inherit';

function toggleApiKind(kinds: CustomLlmApiKind[], kind: CustomLlmApiKind, checked: boolean) {
  const next = checked ? [...kinds, kind] : kinds.filter(k => k !== kind);
  return ENDPOINT_API_KINDS.filter(k => next.includes(k));
}

function ApiKindCheckboxes({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: CustomLlmApiKind[];
  onChange: (kinds: CustomLlmApiKind[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {ENDPOINT_API_KINDS.map(kind => (
        <label
          key={kind}
          htmlFor={`${idPrefix}-${kind}`}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={`${idPrefix}-${kind}`}
            checked={value.includes(kind)}
            onCheckedChange={checked => onChange(toggleApiKind(value, kind, checked))}
          />
          {ENDPOINT_API_KIND_LABELS[kind]}
        </label>
      ))}
    </div>
  );
}

function ClientProviderSelect({
  id,
  value,
  onChange,
  inheritLabel,
}: {
  id: string;
  value: CustomLlmProvider | null;
  onChange: (value: CustomLlmProvider | null) => void;
  inheritLabel?: string;
}) {
  return (
    <Select
      value={value ?? INHERIT}
      onValueChange={next => onChange(next === INHERIT ? null : (next as CustomLlmProvider))}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel ? <SelectItem value={INHERIT}>{inheritLabel}</SelectItem> : null}
        {Object.entries(ENDPOINT_CLIENT_PROVIDER_LABELS).map(([provider, label]) => (
          <SelectItem key={provider} value={provider}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ReasoningFormatSelect({
  id,
  value,
  onChange,
  inheritLabel,
}: {
  id: string;
  value: ByokEndpointReasoningFormat | null;
  onChange: (value: ByokEndpointReasoningFormat | null) => void;
  inheritLabel?: string;
}) {
  return (
    <Select
      value={value ?? INHERIT}
      onValueChange={next =>
        onChange(next === INHERIT ? null : (next as ByokEndpointReasoningFormat))
      }
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel ? <SelectItem value={INHERIT}>{inheritLabel}</SelectItem> : null}
        {Object.entries(ENDPOINT_REASONING_FORMAT_LABELS).map(([format, label]) => (
          <SelectItem key={format} value={format}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const secretProps = {
    id,
    value,
    placeholder,
    autoComplete: 'off',
    spellCheck: false,
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
  };
  return (
    <div className="relative">
      {multiline ? (
        <Textarea
          {...secretProps}
          onChange={e => onChange(e.target.value)}
          rows={5}
          className={cn(
            'pr-10 font-mono text-xs',
            !revealed && '[-webkit-text-security:disc] [text-security:disc]'
          )}
        />
      ) : (
        <Input
          {...secretProps}
          type={revealed ? 'text' : 'password'}
          onChange={e => onChange(e.target.value)}
          className="pr-10"
        />
      )}
      <button
        type="button"
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        aria-pressed={revealed}
        onClick={() => setRevealed(v => !v)}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-0 right-0 flex w-10 items-center justify-center rounded-r-md focus-visible:ring-2 focus-visible:outline-none',
          multiline ? 'h-10' : 'h-full'
        )}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function CredentialsFields({
  value,
  onChange,
  notice,
  onKeepSaved,
}: {
  value: EndpointCredentialsForm;
  onChange: (update: Partial<EndpointCredentialsForm>) => void;
  /** Why the credentials must be entered, when they must. */
  notice?: ReactNode;
  /** Goes back to the saved credentials; absent when they cannot be kept. */
  onKeepSaved?: () => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="type-label mb-2">Credentials</legend>
      {notice}
      <div className="space-y-2">
        <Label htmlFor="endpoint-credentials-type">Authentication</Label>
        <Select
          value={value.type}
          onValueChange={type => onChange({ type: type as ByokEndpointCredentialsType })}
        >
          <SelectTrigger id="endpoint-credentials-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ENDPOINT_CREDENTIALS_TYPE_LABELS).map(([type, label]) => (
              <SelectItem key={type} value={type}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.type === 'api_key' || value.type === 'x-api-key' ? (
        <div className="space-y-2">
          <Label htmlFor="endpoint-api-key">API key</Label>
          <SecretInput
            id="endpoint-api-key"
            value={value.api_key}
            onChange={api_key => onChange({ api_key })}
            placeholder="Enter API key"
          />
          <p className="text-muted-foreground text-xs">
            {value.type === 'api_key'
              ? 'Sent as Authorization: Bearer <key>.'
              : 'Sent in the x-api-key header, as Anthropic expects.'}
          </p>
        </div>
      ) : null}
      {value.type === 'aws_bedrock' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="endpoint-aws-region">Region</Label>
            <Input
              id="endpoint-aws-region"
              value={value.region}
              onChange={e => onChange({ region: e.target.value })}
              placeholder="us-east-1"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endpoint-aws-access-key-id">Access key ID</Label>
            <SecretInput
              id="endpoint-aws-access-key-id"
              value={value.access_key_id}
              onChange={access_key_id => onChange({ access_key_id })}
              placeholder="AKIA…"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endpoint-aws-secret">Secret access key</Label>
            <SecretInput
              id="endpoint-aws-secret"
              value={value.secret_access_key}
              onChange={secret_access_key => onChange({ secret_access_key })}
              placeholder="Secret access key"
            />
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-3">
            Requests are signed with AWS Signature Version 4, for Amazon Bedrock endpoints such as
            bedrock-runtime or bedrock-mantle.
          </p>
        </div>
      ) : null}
      {value.type === 'service_account' ? (
        <div className="space-y-2">
          <Label htmlFor="endpoint-service-account">Service account key</Label>
          <SecretInput
            id="endpoint-service-account"
            value={value.service_account_json}
            onChange={service_account_json => onChange({ service_account_json })}
            placeholder='{"type": "service_account", "project_id": "...", ...}'
            multiline
          />
          <p className="text-muted-foreground text-xs">
            Paste the key file JSON. Requests use a short-lived Google access token as the Bearer
            token.
          </p>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Credentials are encrypted and stored securely. Once saved, they cannot be viewed again.
      </p>
      {onKeepSaved ? (
        <Button type="button" variant="ghost" size="sm" onClick={onKeepSaved}>
          Keep saved credentials
        </Button>
      ) : null}
    </fieldset>
  );
}

function ModelOverrides({
  row,
  endpointApiKinds,
  onChange,
}: {
  row: EndpointModelRow;
  endpointApiKinds: CustomLlmApiKind[];
  onChange: (update: Partial<EndpointModelRow>) => void;
}) {
  const idPrefix = `endpoint-model-${row.rowKey}`;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={row.api_kinds !== null}
            onCheckedChange={checked => onChange({ api_kinds: checked ? endpointApiKinds : null })}
          />
          Override supported APIs
        </label>
        {row.api_kinds ? (
          <ApiKindCheckboxes
            idPrefix={`${idPrefix}-api`}
            value={row.api_kinds}
            onChange={api_kinds => onChange({ api_kinds })}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-client`}>Preferred client API</Label>
        <ClientProviderSelect
          id={`${idPrefix}-client`}
          value={row.client_provider}
          onChange={client_provider => onChange({ client_provider })}
          inheritLabel="Endpoint setting"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-reasoning`}>Reasoning format</Label>
        <ReasoningFormatSelect
          id={`${idPrefix}-reasoning`}
          value={row.reasoning_format}
          onChange={reasoning_format => onChange({ reasoning_format })}
          inheritLabel="Endpoint setting"
        />
      </div>
    </div>
  );
}

function hasOverrides(row: EndpointModelRow) {
  return row.api_kinds !== null || row.client_provider !== null || row.reasoning_format !== null;
}

function ModelsTable({
  rows,
  endpointApiKinds,
  catalogModelIds,
  onChange,
}: {
  rows: EndpointModelRow[];
  endpointApiKinds: CustomLlmApiKind[];
  /** Set in catalog mode, once looked up. */
  catalogModelIds: EndpointCatalogModelIds | null;
  onChange: (rows: EndpointModelRow[]) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const update = (rowKey: string, change: Partial<EndpointModelRow>) =>
    onChange(rows.map(row => (row.rowKey === rowKey ? { ...row, ...change } : row)));
  const toggleExpanded = (rowKey: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  const cellInput = 'h-8 text-xs';

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-muted/50 text-left text-xs">
          <tr>
            <th className="w-8 p-2" aria-label="Overrides" />
            <th className="p-2 font-medium">Model ID</th>
            <th className="p-2 font-medium">Upstream model ID</th>
            <th className="p-2 font-medium">Name</th>
            <th className="w-28 p-2 font-medium">Context window</th>
            <th className="w-28 p-2 font-medium">Max output</th>
            <th className="w-16 p-2 text-center font-medium">Images</th>
            <th className="w-20 p-2 text-center font-medium">Reasoning</th>
            <th className="w-10 p-2" aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isExpanded = expanded.has(row.rowKey);
            const label = row.id.trim() || `model ${index + 1}`;
            return (
              <Fragment key={row.rowKey}>
                <tr className="border-t align-middle">
                  <td className="p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => toggleExpanded(row.rowKey)}
                      aria-expanded={isExpanded}
                      aria-label={`Overrides for ${label}`}
                      className={hasOverrides(row) ? 'text-foreground' : 'text-muted-foreground'}
                    >
                      {isExpanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </td>
                  <td className="p-2">
                    <Input
                      value={row.id}
                      onChange={e => update(row.rowKey, { id: e.target.value })}
                      placeholder="my-model"
                      aria-label={`Model ID of ${label}`}
                      className={`${cellInput} font-mono`}
                    />
                    {catalogModelIds?.checked.has(row.id.trim()) &&
                    !catalogModelIds.served.has(row.id.trim()) ? (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        Not a Kilo catalog model id — not served in catalog mode
                      </p>
                    ) : null}
                  </td>
                  <td className="p-2">
                    <Input
                      value={row.internal_id}
                      onChange={e => update(row.rowKey, { internal_id: e.target.value })}
                      placeholder="Upstream ID"
                      aria-label={`Upstream model ID of ${label}`}
                      className={`${cellInput} font-mono`}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={row.name}
                      onChange={e => update(row.rowKey, { name: e.target.value })}
                      placeholder="Optional"
                      aria-label={`Name of ${label}`}
                      className={cellInput}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={row.context_length}
                      onChange={e => update(row.rowKey, { context_length: e.target.value })}
                      inputMode="numeric"
                      placeholder="200000"
                      aria-label={`Context window of ${label}`}
                      className={`${cellInput} tabular-nums`}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={row.max_completion_tokens}
                      onChange={e => update(row.rowKey, { max_completion_tokens: e.target.value })}
                      inputMode="numeric"
                      placeholder="32000"
                      aria-label={`Max output tokens of ${label}`}
                      className={`${cellInput} tabular-nums`}
                    />
                  </td>
                  <td className="p-2 text-center">
                    <Checkbox
                      checked={row.flags.includes('vision')}
                      onCheckedChange={checked =>
                        update(row.rowKey, {
                          flags: setEndpointModelFlag(row.flags, 'vision', checked),
                        })
                      }
                      aria-label={`${label} accepts images`}
                    />
                  </td>
                  <td className="p-2 text-center">
                    <Checkbox
                      checked={row.flags.includes('reasoning')}
                      onCheckedChange={checked =>
                        update(row.rowKey, {
                          flags: setEndpointModelFlag(row.flags, 'reasoning', checked),
                        })
                      }
                      aria-label={`${label} supports reasoning`}
                    />
                  </td>
                  <td className="p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onChange(rows.filter(r => r.rowKey !== row.rowKey))}
                      disabled={rows.length === 1}
                      aria-label={`Remove ${label}`}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="bg-muted/20">
                    <td />
                    <td colSpan={8} className="p-3">
                      <ModelOverrides
                        row={row}
                        endpointApiKinds={endpointApiKinds}
                        onChange={change => update(row.rowKey, change)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ByokEndpointForm({
  organizationId,
  editingKey,
  onClose,
  onSaved,
}: {
  organizationId: string;
  editingKey: ByokEndpointDialogKey | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const isEditing = editingKey !== null;
  const [form, setForm] = useState<EndpointForm>(() =>
    toEndpointForm(editingKey?.endpoint ?? null)
  );
  const [credentials, setCredentials] = useState(EMPTY_ENDPOINT_CREDENTIALS_FORM);
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [importedModels, setImportedModels] = useState<ByokEndpointModel[] | null>(null);
  const updateForm = (update: Partial<EndpointForm>) =>
    setForm(current => ({ ...current, ...update }));
  const hasPlaceholder = form.base_url.includes(BYOK_ENDPOINT_MODEL_PLACEHOLDER);
  // Saved credentials only go to the host they were saved for.
  const hostChanged = editingKey
    ? !editingKey.endpoint || endpointOriginChanged(editingKey.endpoint.base_url, form.base_url)
    : false;
  const credentialsRequired = !isEditing || hostChanged;
  const showsCredentialInputs = credentialsRequired || replacingCredentials;
  const catalogModelIds = useEndpointCatalogModelIds(
    organizationId,
    form.models.map(row => row.id),
    editingKey?.serve_catalog_models ?? false
  );
  const credentialsInput = showsCredentialInputs ? credentials : EMPTY_ENDPOINT_CREDENTIALS_FORM;

  const mutationOptions = {
    onSuccess: () => {
      toast.success(isEditing ? 'Endpoint updated' : 'Endpoint added');
      onSaved();
    },
    onError: (error: { message: string }) => setErrors([error.message]),
  };
  const createMutation = useMutation(trpc.byok.createEndpoint.mutationOptions(mutationOptions));
  const updateMutation = useMutation(trpc.byok.updateEndpoint.mutationOptions(mutationOptions));
  const listModelsMutation = useMutation(
    trpc.byok.listModelsFromEndpoint.mutationOptions({
      onSuccess: ({ models }) => {
        if (models.length === 0) {
          toast.error('The endpoint lists no chat models.');
          return;
        }
        setImportedModels(models);
      },
      onError: error => toast.error(`Failed to import models: ${error.message}`),
    })
  );
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const handleImport = () => {
    const builtCredentials = buildEndpointCredentials(credentialsInput, {
      optional: !credentialsRequired,
    });
    if (!builtCredentials.success) {
      setErrors(builtCredentials.errors);
      return;
    }
    setErrors([]);
    listModelsMutation.mutate({
      organizationId,
      base_url: form.base_url.trim(),
      ...(builtCredentials.data
        ? { credentials: builtCredentials.data }
        : editingKey && { id: editingKey.id }),
    });
  };

  const handleSave = () => {
    const definition = buildEndpointDefinition(form);
    const builtCredentials = buildEndpointCredentials(credentialsInput, {
      optional: !credentialsRequired,
    });
    const nextErrors = [
      ...(definition.success ? [] : definition.errors),
      ...(builtCredentials.success ? [] : builtCredentials.errors),
    ];
    setErrors(nextErrors);
    if (!definition.success || !builtCredentials.success) return;
    if (editingKey) {
      updateMutation.mutate({
        organizationId,
        id: editingKey.id,
        definition: definition.data,
        ...(builtCredentials.data && { credentials: builtCredentials.data }),
      });
    } else if (builtCredentials.data) {
      createMutation.mutate({
        organizationId,
        definition: definition.data,
        credentials: builtCredentials.data,
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit endpoint' : 'Add endpoint'}</DialogTitle>
        <DialogDescription>
          Route requests to your own OpenAI- or Anthropic-compatible API. Requests use your
          endpoint&apos;s billing instead of your Kilo balance.
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-6 min-h-0 space-y-6 overflow-y-auto px-6 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="endpoint-name">Name</Label>
            <Input
              id="endpoint-name"
              value={form.name}
              onChange={e => updateForm({ name: e.target.value })}
              placeholder="Internal gateway"
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endpoint-base-url">Base URL</Label>
            <Input
              id="endpoint-base-url"
              value={form.base_url}
              onChange={e => updateForm({ base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              inputMode="url"
              className="font-mono text-xs"
            />
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            The API root, without a trailing slash; requests go to /chat/completions, /messages, or
            /responses under it. Include <code>{BYOK_ENDPOINT_MODEL_PLACEHOLDER}</code> to send the
            upstream model ID in the URL instead of the request body, for example{' '}
            <code>https://example.com/models/{BYOK_ENDPOINT_MODEL_PLACEHOLDER}/v1</code>. The
            placeholder is only supported for Chat Completions.
          </p>
        </div>

        {showsCredentialInputs ? (
          <CredentialsFields
            value={credentials}
            onChange={update => setCredentials(current => ({ ...current, ...update }))}
            notice={
              isEditing && hostChanged ? (
                <Alert>
                  <Info className="size-4" />
                  <AlertDescription>
                    The base URL points to a different host than the saved one. Enter the
                    credentials again; saved credentials are never sent to another host.
                  </AlertDescription>
                </Alert>
              ) : undefined
            }
            onKeepSaved={
              isEditing && !hostChanged
                ? () => {
                    setCredentials(EMPTY_ENDPOINT_CREDENTIALS_FORM);
                    setReplacingCredentials(false);
                  }
                : undefined
            }
          />
        ) : (
          <fieldset className="space-y-3">
            <legend className="type-label mb-2">Credentials</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-sm">
                Saved credentials are kept. They cannot be viewed.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReplacingCredentials(true)}
              >
                Replace credentials
              </Button>
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-4">
          <legend className="type-label mb-2">APIs</legend>
          <div className="space-y-2">
            <span className="text-sm">Supported APIs</span>
            <ApiKindCheckboxes
              idPrefix="endpoint-api-kind"
              value={form.api_kinds}
              onChange={api_kinds => updateForm({ api_kinds })}
            />
            <p className="text-muted-foreground text-xs">
              The APIs the endpoint serves. Requests over other APIs are not sent to it.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="endpoint-client-provider">Preferred client API</Label>
              <ClientProviderSelect
                id="endpoint-client-provider"
                value={form.client_provider}
                onChange={client_provider => client_provider && updateForm({ client_provider })}
              />
              <p className="text-muted-foreground text-xs">
                The API Kilo clients use for these models. It must be a supported API.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="endpoint-reasoning-format">Reasoning format</Label>
              <ReasoningFormatSelect
                id="endpoint-reasoning-format"
                value={form.reasoning_format}
                onChange={reasoning_format => reasoning_format && updateForm({ reasoning_format })}
              />
              <p className="text-muted-foreground text-xs">
                How the endpoint returns reasoning in Chat Completions responses.
              </p>
            </div>
          </div>
        </fieldset>

        <section className="space-y-3" aria-labelledby="endpoint-models-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="endpoint-models-heading" className="type-label">
              Models{' '}
              <span className="text-muted-foreground font-normal">({form.models.length})</span>
            </h3>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleImport}
                disabled={!form.base_url.trim() || hasPlaceholder || listModelsMutation.isPending}
              >
                <Download />
                {listModelsMutation.isPending ? 'Importing…' : 'Import from /models'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateForm({ models: [...form.models, toEndpointModelRow()] })}
                disabled={form.models.length >= BYOK_ENDPOINT_MAX_MODELS}
              >
                <Plus />
                Add model
              </Button>
            </div>
          </div>
          {hasPlaceholder ? (
            <p className="text-muted-foreground text-xs">
              Import is unavailable when the base URL contains{' '}
              <code>{BYOK_ENDPOINT_MODEL_PLACEHOLDER}</code>. Add the models manually.
            </p>
          ) : null}
          <Alert>
            <Info className="size-4" />
            <AlertDescription className="space-y-1">
              {editingKey?.serve_catalog_models ? (
                <p>
                  This endpoint uses Kilo catalog model IDs: each model ID must be a Kilo catalog
                  ID, such as <code>anthropic/claude-sonnet-4.5</code>, and requests for that
                  catalog model are served by this endpoint with the upstream model ID. Organization
                  model restrictions apply.
                </p>
              ) : (
                <>
                  <p>
                    Clients select these models as <code>endpoint-…/&lt;model ID&gt;</code>. The
                    upstream model ID is what the endpoint receives.
                  </p>
                  <p>
                    With Kilo catalog model IDs turned on in the key list, each model ID must
                    instead be a Kilo catalog ID, such as <code>anthropic/claude-sonnet-4.5</code>,
                    and requests for that catalog model are served by this endpoint.
                  </p>
                </>
              )}
            </AlertDescription>
          </Alert>
          <ModelsTable
            rows={form.models}
            endpointApiKinds={form.api_kinds}
            catalogModelIds={catalogModelIds}
            onChange={models => updateForm({ models })}
          />
        </section>

        {errors.length > 0 ? (
          <Alert variant="destructive" id="endpoint-errors">
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {errors.map(error => (
                  <li key={error} className="whitespace-break-spaces">
                    {error}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving…' : isEditing ? 'Save endpoint' : 'Add endpoint'}
        </Button>
      </DialogFooter>

      {importedModels ? (
        <ByokEndpointImportDialog
          models={importedModels}
          listedInternalIds={new Set(form.models.map(row => row.internal_id.trim()))}
          onClose={() => setImportedModels(null)}
          onAdd={models => {
            setForm(current => ({
              ...current,
              models: mergeImportedModels(current.models, models),
            }));
            setImportedModels(null);
          }}
        />
      ) : null}
    </>
  );
}

export function ByokEndpointDialog({
  organizationId,
  open,
  editingKey,
  onOpenChange,
  onSaved,
}: {
  organizationId: string;
  open: boolean;
  /** The endpoint key being edited, or null to add one. */
  editingKey: ByokEndpointDialogKey | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto]">
        {open ? (
          <ByokEndpointForm
            key={editingKey?.id ?? 'new'}
            organizationId={organizationId}
            editingKey={editingKey}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
