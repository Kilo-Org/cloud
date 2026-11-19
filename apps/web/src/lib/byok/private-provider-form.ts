import {
  BYOK_PRIVATE_PROVIDER_MAX_MODELS,
  CustomLlmApiKindSchema,
  getCustomLlmClientApiKind,
  ByokPrivateProviderCredentialsSchema,
  ByokPrivateProviderDefinitionSchema,
  type ByokPrivateProviderCredentials,
  type ByokPrivateProviderDefinition,
  type ByokPrivateModel,
  type ByokPrivateProviderReasoningFormat,
  type CustomLlmApiKind,
  type CustomLlmProvider,
  type DirectByokModelFlag,
} from '@kilocode/db/schema-types';
import type * as z from 'zod';
import { formatZodIssues } from '@/lib/zod/format-zod-error';
import { API_KIND_LABELS } from '@/lib/api-kind-labels';

export type ByokPrivateProviderCredentialsType = ByokPrivateProviderCredentials['type'];

export const PRIVATE_PROVIDER_API_KINDS = CustomLlmApiKindSchema.options;

/** The AI SDK providers clients may use, in the order of the APIs they call. */
export const PRIVATE_PROVIDER_CLIENT_PROVIDERS = [
  'openrouter',
  'anthropic',
  'openai',
] as const satisfies readonly CustomLlmProvider[];

/** A client provider is named after the API it calls. */
export function privateProviderClientProviderLabel(provider: CustomLlmProvider): string {
  return API_KIND_LABELS[getCustomLlmClientApiKind(provider)];
}

export const PRIVATE_PROVIDER_REASONING_FORMAT_LABELS = {
  'reasoning-details': 'OpenRouter reasoning_details',
  'reasoning-content': 'reasoning_content',
  reasoning: 'reasoning',
  'gemini-thought': 'Gemini thought signatures',
} as const satisfies Record<ByokPrivateProviderReasoningFormat, string>;

export const PRIVATE_PROVIDER_CREDENTIALS_TYPE_LABELS = {
  api_key: 'API key (Bearer)',
  'x-api-key': 'API key (x-api-key header)',
  aws_bedrock: 'AWS access keys',
  service_account: 'Google service account JSON',
} as const satisfies Record<ByokPrivateProviderCredentialsType, string>;

export type PrivateModelRow = {
  /** A stable React key; not saved. */
  rowKey: string;
  id: string;
  internal_id: string;
  name: string;
  context_length: string;
  max_completion_tokens: string;
  /** Kept as stored, so flags the form does not edit, such as `recommended`, survive. */
  flags: DirectByokModelFlag[];
  /** Null uses the private provider setting. */
  api_kinds: CustomLlmApiKind[] | null;
  client_provider: CustomLlmProvider | null;
  reasoning_format: ByokPrivateProviderReasoningFormat | null;
  send_prompt_cache_key: boolean | null;
};

export type PrivateProviderForm = {
  name: string;
  base_url: string;
  api_kinds: CustomLlmApiKind[];
  client_provider: CustomLlmProvider;
  reasoning_format: ByokPrivateProviderReasoningFormat;
  send_prompt_cache_key: boolean;
  models: PrivateModelRow[];
};

/** Only Chat Completions and Responses requests carry a `prompt_cache_key`. */
export function sendsPromptCacheKeyOver(apiKinds: readonly CustomLlmApiKind[]): boolean {
  return apiKinds.some(apiKind => apiKind === 'chat_completions' || apiKind === 'responses');
}

export type PrivateProviderCredentialsForm = {
  type: ByokPrivateProviderCredentialsType;
  api_key: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  service_account_json: string;
};

export const EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM: PrivateProviderCredentialsForm = {
  type: 'api_key',
  api_key: '',
  region: '',
  access_key_id: '',
  secret_access_key: '',
  service_account_json: '',
};

const MAX_MODEL_ID_LENGTH = 200;

let nextRowKey = 0;

export function toPrivateModelRow(model?: ByokPrivateModel): PrivateModelRow {
  nextRowKey += 1;
  return {
    rowKey: `model-${nextRowKey}`,
    id: model?.id ?? '',
    internal_id: model?.internal_id ?? '',
    name: model?.name ?? '',
    context_length: model ? String(model.context_length) : '',
    max_completion_tokens: model ? String(model.max_completion_tokens) : '',
    flags: [...(model?.flags ?? [])],
    api_kinds: model?.api_kinds ?? null,
    client_provider: model?.client_provider ?? null,
    reasoning_format: model?.reasoning_format ?? null,
    send_prompt_cache_key: model?.send_prompt_cache_key ?? null,
  };
}

export function toPrivateProviderForm(
  definition: ByokPrivateProviderDefinition | null
): PrivateProviderForm {
  if (!definition) {
    return {
      name: '',
      base_url: '',
      api_kinds: ['chat_completions'],
      client_provider: 'openrouter',
      reasoning_format: 'reasoning-details',
      send_prompt_cache_key: false,
      models: [toPrivateModelRow()],
    };
  }
  return {
    name: definition.name,
    base_url: definition.base_url,
    api_kinds: definition.api_kinds,
    client_provider: definition.client_provider,
    reasoning_format: definition.reasoning_format,
    send_prompt_cache_key: definition.send_prompt_cache_key ?? false,
    models: definition.models.map(toPrivateModelRow),
  };
}

export function setPrivateModelFlag(
  flags: readonly DirectByokModelFlag[],
  flag: DirectByokModelFlag,
  enabled: boolean
): DirectByokModelFlag[] {
  const others = flags.filter(candidate => candidate !== flag);
  return enabled ? [...others, flag] : others;
}

function toNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function toPrivateModel(row: PrivateModelRow): Record<string, unknown> {
  return {
    id: row.id.trim(),
    internal_id: row.internal_id.trim(),
    ...(row.name.trim() && { name: row.name.trim() }),
    context_length: toNumber(row.context_length),
    max_completion_tokens: toNumber(row.max_completion_tokens),
    ...(row.flags.length > 0 && { flags: row.flags }),
    ...(row.api_kinds && { api_kinds: row.api_kinds }),
    ...(row.client_provider && { client_provider: row.client_provider }),
    ...(row.reasoning_format && { reasoning_format: row.reasoning_format }),
    ...(row.send_prompt_cache_key !== null && { send_prompt_cache_key: row.send_prompt_cache_key }),
  };
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  base_url: 'Base URL',
  api_kinds: 'Supported APIs',
  client_provider: 'Preferred client API',
  reasoning_format: 'Reasoning format',
  send_prompt_cache_key: 'Send prompt cache key',
  models: 'Models',
  id: 'Model ID',
  internal_id: 'Upstream model ID',
  context_length: 'Context window',
  max_completion_tokens: 'Max output tokens',
};

function describeIssue(issue: z.core.$ZodIssue, form: PrivateProviderForm): string {
  const [first, index, field] = issue.path;
  if (first === 'models' && typeof index === 'number') {
    const modelId = form.models[index]?.id.trim();
    const model = `Model ${index + 1}${modelId ? ` (${modelId})` : ''}`;
    const label = typeof field === 'string' ? (FIELD_LABELS[field] ?? field) : undefined;
    return label ? `${model}, ${label}: ${issue.message}` : `${model}: ${issue.message}`;
  }
  if (typeof first === 'string' && issue.path.length === 1) {
    return `${FIELD_LABELS[first] ?? first}: ${issue.message}`;
  }
  return formatZodIssues([issue]).join('\n');
}

export type BuildResult<T> = { success: true; data: T } | { success: false; errors: string[] };

export function buildPrivateProviderDefinition(
  form: PrivateProviderForm
): BuildResult<ByokPrivateProviderDefinition> {
  const result = ByokPrivateProviderDefinitionSchema.safeParse({
    name: form.name,
    base_url: form.base_url.trim(),
    api_kinds: form.api_kinds,
    client_provider: form.client_provider,
    reasoning_format: form.reasoning_format,
    ...(form.send_prompt_cache_key && { send_prompt_cache_key: true }),
    models: form.models.map(toPrivateModel),
  });
  if (result.success) return result;
  return {
    success: false,
    errors: [...new Set(result.error.issues.map(i => describeIssue(i, form)))],
  };
}

function hasCredentialsInput(form: PrivateProviderCredentialsForm): boolean {
  switch (form.type) {
    case 'api_key':
    case 'x-api-key':
      return form.api_key.trim() !== '';
    case 'aws_bedrock':
      return [form.region, form.access_key_id, form.secret_access_key].some(v => v.trim() !== '');
    case 'service_account':
      return form.service_account_json.trim() !== '';
  }
}

/**
 * The credentials the form describes. Only with `keepSaved`, the user's explicit choice to keep
 * the stored credentials, does it yield null without reading the form; otherwise they are required.
 */
export function buildPrivateProviderCredentials(
  form: PrivateProviderCredentialsForm,
  { keepSaved }: { keepSaved: boolean }
): BuildResult<ByokPrivateProviderCredentials | null> {
  if (keepSaved) return { success: true, data: null };
  if (!hasCredentialsInput(form)) {
    return { success: false, errors: ['Enter the private provider credentials.'] };
  }
  let input: unknown;
  switch (form.type) {
    case 'api_key':
    case 'x-api-key':
      input = { type: form.type, api_key: form.api_key.trim() };
      break;
    case 'aws_bedrock':
      input = {
        type: form.type,
        region: form.region.trim(),
        access_key_id: form.access_key_id.trim(),
        secret_access_key: form.secret_access_key.trim(),
      };
      break;
    case 'service_account':
      try {
        input = JSON.parse(form.service_account_json);
      } catch {
        return { success: false, errors: ['The service account key is not valid JSON.'] };
      }
      break;
  }
  const result = ByokPrivateProviderCredentialsSchema.safeParse(input);
  if (result.success) return result;
  return {
    success: false,
    errors: formatZodIssues(result.error.issues).map(message => `Credentials: ${message}`),
  };
}

/** A row still as `toPrivateModelRow()` creates it: nothing the user would lose by dropping it. */
function isUntouchedRow(row: PrivateModelRow): boolean {
  return (
    [row.id, row.internal_id, row.name, row.context_length, row.max_completion_tokens].every(
      value => value.trim() === ''
    ) &&
    row.flags.length === 0 &&
    row.api_kinds === null &&
    row.client_provider === null &&
    row.reasoning_format === null &&
    row.send_prompt_cache_key === null
  );
}

/** How many more models the private provider can take, as `mergeImportedModels` counts the rows. */
export function getImportCapacity(rows: PrivateModelRow[]): number {
  return Math.max(
    0,
    BYOK_PRIVATE_PROVIDER_MAX_MODELS - rows.filter(row => !isUntouchedRow(row)).length
  );
}

/** Adds upstream ids to a selection, in order, without exceeding `capacity` selected. */
export function addToImportSelection(
  selected: ReadonlySet<string>,
  internalIds: readonly string[],
  capacity: number
): Set<string> {
  const next = new Set(selected);
  for (const internalId of internalIds) {
    if (next.size >= capacity) break;
    next.add(internalId);
  }
  return next;
}

/**
 * Adds imported models after the existing rows, skipping models whose upstream id is already
 * listed and renaming a public id that is taken. A single empty row is replaced.
 */
export function mergeImportedModels(
  rows: PrivateModelRow[],
  imported: ByokPrivateModel[]
): PrivateModelRow[] {
  const kept = rows.filter(row => !isUntouchedRow(row));
  const internalIds = new Set(kept.map(row => row.internal_id.trim()));
  const ids = new Set(kept.map(row => row.id.trim()));
  const added: PrivateModelRow[] = [];
  for (const model of imported) {
    if (internalIds.has(model.internal_id)) continue;
    let id = model.id;
    for (let suffix = 2; ids.has(id); suffix++) {
      id = `${model.id.slice(0, MAX_MODEL_ID_LENGTH - String(suffix).length - 1)}-${suffix}`;
    }
    ids.add(id);
    internalIds.add(model.internal_id);
    added.push(toPrivateModelRow({ ...model, id }));
  }
  return [...kept, ...added];
}
