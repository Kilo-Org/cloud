'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import type {
  ManualByokAiSdkProvider,
  ManualByokApiKind,
  ManualByokModel,
  ManualByokProviderDefinition,
} from '@kilocode/db/schema-types';
import { ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

const API_OPTIONS = [
  { id: 'messages', label: 'Messages' },
  { id: 'chat_completions', label: 'Chat Completions' },
  { id: 'responses', label: 'Responses' },
] as const satisfies ReadonlyArray<{ id: ManualByokApiKind; label: string }>;

const AI_SDK_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai-compatible', label: 'OpenAI Compatible' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
] as const satisfies ReadonlyArray<{ id: ManualByokAiSdkProvider; label: string }>;

export const INITIAL_MANUAL_BYOK_SETTINGS: ManualByokProviderDefinition = {
  name: '',
  base_url: '',
  use_x_api_key: false,
  supported_apis: ['chat_completions'],
  preferred_ai_sdk_provider: 'openai-compatible',
  model_defaults: {
    supports_image_input: true,
    supports_reasoning: true,
    add_cache_breakpoints: false,
  },
  models: [{ id: '' }],
};

function optionalNumber(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function JsonField({
  id,
  label,
  value,
  placeholder,
  onChange,
  onValidityChange,
}: {
  id: string;
  label: string;
  value: unknown;
  placeholder: string;
  onChange(value: unknown): void;
  onValidityChange(valid: boolean): void;
}) {
  const [raw, setRaw] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRaw(value === undefined ? '' : JSON.stringify(value, null, 2));
  }, [value]);

  const parse = () => {
    if (!raw.trim()) {
      setError(null);
      onValidityChange(true);
      onChange(undefined);
      return;
    }
    try {
      onChange(JSON.parse(raw));
      setError(null);
      onValidityChange(true);
    } catch {
      setError('Enter valid JSON.');
      onValidityChange(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={raw}
        onChange={event => setRaw(event.target.value)}
        onBlur={parse}
        placeholder={placeholder}
        className="min-h-24 font-mono text-xs"
        aria-invalid={!!error}
      />
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function InheritedBooleanSelect({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange(value: boolean | undefined): void;
}) {
  return (
    <Select
      value={value === undefined ? 'inherit' : value ? 'on' : 'off'}
      onValueChange={next => onChange(next === 'inherit' ? undefined : next === 'on')}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">Use provider default</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ModelFields({
  model,
  index,
  canRemove,
  onChange,
  onRemove,
  onJsonValidityChange,
}: {
  model: ManualByokModel;
  index: number;
  canRemove: boolean;
  onChange(model: ManualByokModel): void;
  onRemove(): void;
  onJsonValidityChange(id: string, valid: boolean): void;
}) {
  return (
    <div className="bg-muted/30 space-y-4 rounded-md border p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="font-medium">Model {index + 1}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove model ${index + 1}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`manual-model-id-${index}`}>Model ID</Label>
          <Input
            id={`manual-model-id-${index}`}
            value={model.id}
            onChange={event => onChange({ ...model, id: event.target.value })}
            placeholder="provider/model-id"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`manual-model-name-${index}`}>Name</Label>
          <Input
            id={`manual-model-name-${index}`}
            value={model.name ?? ''}
            onChange={event => onChange({ ...model, name: event.target.value || undefined })}
            placeholder="Defaults to model ID"
          />
        </div>
        <div className="space-y-2">
          <Label>Image support</Label>
          <InheritedBooleanSelect
            value={model.supports_image_input}
            onChange={value => onChange({ ...model, supports_image_input: value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Reasoning</Label>
          <InheritedBooleanSelect
            value={model.supports_reasoning}
            onChange={value => onChange({ ...model, supports_reasoning: value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Cache breakpoints</Label>
          <InheritedBooleanSelect
            value={model.add_cache_breakpoints}
            onChange={value => onChange({ ...model, add_cache_breakpoints: value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Preferred AI SDK provider</Label>
          <Select
            value={model.preferred_ai_sdk_provider ?? 'inherit'}
            onValueChange={value =>
              onChange({
                ...model,
                preferred_ai_sdk_provider:
                  value === 'inherit' ? undefined : (value as ManualByokAiSdkProvider),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Use provider default</SelectItem>
              {AI_SDK_PROVIDERS.map(provider => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`manual-model-context-${index}`}>Max context length</Label>
          <Input
            id={`manual-model-context-${index}`}
            type="number"
            min={1}
            value={model.context_length ?? ''}
            onChange={event =>
              onChange({ ...model, context_length: optionalNumber(event.target.value) })
            }
            placeholder="Use provider default"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`manual-model-output-${index}`}>Max output tokens</Label>
          <Input
            id={`manual-model-output-${index}`}
            type="number"
            min={1}
            value={model.max_completion_tokens ?? ''}
            onChange={event =>
              onChange({ ...model, max_completion_tokens: optionalNumber(event.target.value) })
            }
            placeholder="Use provider default"
          />
        </div>
      </div>
      <JsonField
        id={`manual-model-variants-${index}`}
        label="Variants"
        value={model.variants}
        placeholder='{"high":{"reasoning":{"enabled":true,"effort":"high"},"verbosity":"high"}}'
        onChange={variants =>
          onChange({ ...model, variants: variants as ManualByokModel['variants'] })
        }
        onValidityChange={valid => onJsonValidityChange(`model-${index}-variants`, valid)}
      />
    </div>
  );
}

export function ManualByokProviderFields({
  code,
  settings,
  apiKey,
  editing,
  onCodeChange,
  onSettingsChange,
  onJsonValidityChange,
}: {
  code: string;
  settings: ManualByokProviderDefinition;
  apiKey: string;
  editing: boolean;
  onCodeChange(value: string): void;
  onSettingsChange(value: ManualByokProviderDefinition): void;
  onJsonValidityChange(valid: boolean): void;
}) {
  const invalidJsonFields = useRef(new Set<string>());
  const trpc = useTRPC();
  const fetchModels = useMutation(
    trpc.byok.fetchManualModels.mutationOptions({
      onSuccess: models => {
        for (const id of invalidJsonFields.current) {
          if (id.startsWith('model-')) invalidJsonFields.current.delete(id);
        }
        onJsonValidityChange(invalidJsonFields.current.size === 0);
        const fetchedIds = new Set(models.map(model => model.id.toLowerCase()));
        const existingModels = new Map(
          settings.models.map(model => [model.id.toLowerCase(), model] as const)
        );
        const mergedModels = models.map(model => ({
          ...model,
          ...existingModels.get(model.id.toLowerCase()),
          id: model.id,
        }));
        onSettingsChange({
          ...settings,
          models: [
            ...mergedModels,
            ...settings.models.filter(model => model.id && !fetchedIds.has(model.id.toLowerCase())),
          ],
        });
        toast.success(`Loaded ${models.length} model${models.length === 1 ? '' : 's'}`);
      },
      onError: error => toast.error(error.message),
    })
  );

  const updateJsonValidity = (id: string, valid: boolean) => {
    if (valid) invalidJsonFields.current.delete(id);
    else invalidJsonFields.current.add(id);
    onJsonValidityChange(invalidJsonFields.current.size === 0);
  };

  const removeModelJsonValidity = (removedIndex: number) => {
    const next = new Set<string>();
    for (const id of invalidJsonFields.current) {
      const match = /^model-(\d+)-variants$/.exec(id);
      if (!match) {
        next.add(id);
        continue;
      }
      const index = Number(match[1]);
      if (index < removedIndex) next.add(id);
      if (index > removedIndex) next.add(`model-${index - 1}-variants`);
    }
    invalidJsonFields.current = next;
    onJsonValidityChange(next.size === 0);
  };
  const toggleApi = (api: ManualByokApiKind, enabled: boolean) => {
    onSettingsChange({
      ...settings,
      supported_apis: enabled
        ? [...settings.supported_apis, api]
        : settings.supported_apis.filter(candidate => candidate !== api),
    });
  };

  const updateModel = (index: number, model: ManualByokModel) => {
    onSettingsChange({
      ...settings,
      models: settings.models.map((current, modelIndex) =>
        modelIndex === index ? model : current
      ),
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="manual-provider-code">Provider code</Label>
          <div className="flex items-center rounded-md border">
            <span className="text-muted-foreground border-r px-3 font-mono text-sm">manual:</span>
            <Input
              id="manual-provider-code"
              value={code}
              onChange={event => onCodeChange(event.target.value)}
              placeholder="my-provider"
              disabled={editing}
              className="border-0 font-mono focus-visible:ring-0"
            />
          </div>
          <p className="text-muted-foreground text-xs">Lowercase letters and hyphens only.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="manual-provider-name">Name</Label>
          <Input
            id="manual-provider-name"
            value={settings.name}
            onChange={event => onSettingsChange({ ...settings, name: event.target.value })}
            placeholder="My provider"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="manual-base-url">Base URL</Label>
          <Input
            id="manual-base-url"
            type="url"
            value={settings.base_url}
            onChange={event => onSettingsChange({ ...settings, base_url: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
          <p className="text-muted-foreground text-xs">
            This URL is shared by every supported API. Create another provider for a different
            endpoint.
          </p>
        </div>
        <Label>Supported APIs</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {API_OPTIONS.map(api => (
            <label key={api.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={settings.supported_apis.includes(api.id)}
                onCheckedChange={checked => toggleApi(api.id, checked === true)}
              />
              {api.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Preferred AI SDK provider</Label>
          <Select
            value={settings.preferred_ai_sdk_provider}
            onValueChange={value =>
              onSettingsChange({
                ...settings,
                preferred_ai_sdk_provider: value as ManualByokAiSdkProvider,
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AI_SDK_PROVIDERS.map(provider => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="manual-x-api-key">Use X-Api-Key</Label>
            <p className="text-muted-foreground text-xs">For Anthropic-style authentication.</p>
          </div>
          <Switch
            id="manual-x-api-key"
            checked={settings.use_x_api_key}
            onCheckedChange={use_x_api_key => onSettingsChange({ ...settings, use_x_api_key })}
          />
        </div>
      </div>

      <div className="space-y-4">
        <Label>Model defaults</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['supports_image_input', 'Image support'],
            ['supports_reasoning', 'Reasoning'],
            ['add_cache_breakpoints', 'Cache breakpoints'],
          ].map(([key, label]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <Label htmlFor={`manual-default-${key}`}>{label}</Label>
              <Switch
                id={`manual-default-${key}`}
                checked={
                  settings.model_defaults[
                    key as keyof Pick<
                      typeof settings.model_defaults,
                      'supports_image_input' | 'supports_reasoning' | 'add_cache_breakpoints'
                    >
                  ] as boolean
                }
                onCheckedChange={checked =>
                  onSettingsChange({
                    ...settings,
                    model_defaults: { ...settings.model_defaults, [key]: checked },
                  })
                }
              />
            </div>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="manual-default-context">Max context length</Label>
            <Input
              id="manual-default-context"
              type="number"
              min={1}
              value={settings.model_defaults.context_length ?? ''}
              onChange={event =>
                onSettingsChange({
                  ...settings,
                  model_defaults: {
                    ...settings.model_defaults,
                    context_length: optionalNumber(event.target.value),
                  },
                })
              }
              placeholder="200000"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-default-output">Max output tokens</Label>
            <Input
              id="manual-default-output"
              type="number"
              min={1}
              value={settings.model_defaults.max_completion_tokens ?? ''}
              onChange={event =>
                onSettingsChange({
                  ...settings,
                  model_defaults: {
                    ...settings.model_defaults,
                    max_completion_tokens: optionalNumber(event.target.value),
                  },
                })
              }
              placeholder="32000"
            />
          </div>
        </div>
        <JsonField
          id="manual-default-variants"
          label="Default variants"
          value={settings.model_defaults.variants}
          placeholder='{"high":{"reasoning":{"enabled":true,"effort":"high"},"verbosity":"high"}}'
          onChange={variants =>
            onSettingsChange({
              ...settings,
              model_defaults: {
                ...settings.model_defaults,
                variants: variants as ManualByokProviderDefinition['model_defaults']['variants'],
              },
            })
          }
          onValidityChange={valid => updateJsonValidity('default-variants', valid)}
        />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Label>Models</Label>
            <p className="text-muted-foreground text-xs">
              Load an OpenAI-compatible /models endpoint or add models manually.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!settings.base_url || !apiKey || fetchModels.isPending}
              onClick={() => {
                if (!settings.base_url) return;
                fetchModels.mutate({
                  base_url: settings.base_url,
                  api_key: apiKey,
                  use_x_api_key: settings.use_x_api_key,
                });
              }}
            >
              {fetchModels.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Load /models
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                onSettingsChange({ ...settings, models: [...settings.models, { id: '' }] })
              }
            >
              <Plus className="mr-2 size-4" /> Add model
            </Button>
          </div>
        </div>
        {settings.models.map((model, index) => (
          <ModelFields
            key={index}
            model={model}
            index={index}
            canRemove={settings.models.length > 1}
            onChange={next => updateModel(index, next)}
            onRemove={() => {
              removeModelJsonValidity(index);
              onSettingsChange({
                ...settings,
                models: settings.models.filter((_, modelIndex) => modelIndex !== index),
              });
            }}
            onJsonValidityChange={updateJsonValidity}
          />
        ))}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm font-medium">
          <ChevronDown className="size-4" /> Advanced request options
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4 space-y-4">
          <p className="text-muted-foreground text-xs">
            These options apply to every model and API. Create a separate provider when they need to
            differ.
          </p>
          <JsonField
            id="manual-extra-body"
            label="Extra body"
            value={settings.extra_body}
            placeholder='{"service_tier":"default"}'
            onChange={extra_body =>
              onSettingsChange({
                ...settings,
                extra_body: extra_body as ManualByokProviderDefinition['extra_body'],
              })
            }
            onValidityChange={valid => updateJsonValidity('extra-body', valid)}
          />
          <JsonField
            id="manual-extra-headers"
            label="Extra headers"
            value={settings.extra_headers}
            placeholder='{"X-Custom-Header":"value"}'
            onChange={extra_headers =>
              onSettingsChange({
                ...settings,
                extra_headers: extra_headers as ManualByokProviderDefinition['extra_headers'],
              })
            }
            onValidityChange={valid => updateJsonValidity('extra-headers', valid)}
          />
          <JsonField
            id="manual-remove-body"
            label="Remove from body"
            value={settings.remove_from_body}
            placeholder='["stream_options"]'
            onChange={remove_from_body =>
              onSettingsChange({
                ...settings,
                remove_from_body:
                  remove_from_body as ManualByokProviderDefinition['remove_from_body'],
              })
            }
            onValidityChange={valid => updateJsonValidity('remove-from-body', valid)}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
