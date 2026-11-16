import { ByokEndpointModelIdSchema, type ByokEndpointModel } from '@kilocode/db/schema-types';

const DEFAULT_CONTEXT_LENGTH = 128_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_INTERNAL_ID_LENGTH = 500;
const MAX_NAME_LENGTH = 200;
/** Bounds the import list; an endpoint itself keeps at most `BYOK_ENDPOINT_MAX_MODELS`. */
const MAX_LISTED_MODELS = 5_000;

/** Model kinds that cannot serve chat requests, as `type` or `model_type` name them. */
const NON_CHAT_MODEL_TYPES = new Set([
  'embedding',
  'embeddings',
  'evaluation',
  'image',
  'moderation',
  'realtime',
  'rerank',
  'reranking',
  'speech',
  'transcription',
  'tts',
  'video',
]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 1) return undefined;
  return Math.floor(number);
}

function firstPositiveInteger(entry: JsonObject, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = positiveInteger(field(entry, ...path));
    if (value !== undefined) return value;
  }
  return undefined;
}

function includesImage(value: unknown): boolean {
  return Array.isArray(value) && value.includes('image');
}

function supportsImageInput(entry: JsonObject): boolean {
  const modalities = entry.modalities;
  return (
    includesImage(field(entry, 'architecture', 'input_modalities')) ||
    includesImage(entry.input_modalities) ||
    includesImage(modalities) ||
    includesImage(field(modalities, 'input')) ||
    field(entry, 'capabilities', 'vision') === true ||
    field(entry, 'capabilities', 'image_input') === true ||
    field(entry, 'capabilities', 'image_input', 'supported') === true
  );
}

function isChatModel(entry: JsonObject): boolean {
  for (const type of [entry.type, entry.model_type]) {
    if (typeof type === 'string' && NON_CHAT_MODEL_TYPES.has(type.toLowerCase())) return false;
  }
  return field(entry, 'capabilities', 'completion_chat') !== false;
}

/**
 * A public model id for an upstream id: lowercase, with every character the gateway does not
 * allow in model ids replaced by `-`. Returns null when nothing usable is left.
 */
export function toByokEndpointModelId(internalId: string): string | null {
  const id = internalId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_MODEL_ID_LENGTH)
    .replace(/^[-/]+|[-/]+$/g, '');
  return ByokEndpointModelIdSchema.safeParse(id).success ? id : null;
}

function uniqueModelId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${id.slice(0, MAX_MODEL_ID_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function modelEntries(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  for (const key of ['data', 'models']) {
    const entries = field(response, key);
    if (Array.isArray(entries)) return entries;
  }
  return [];
}

/**
 * Reads the models of an OpenAI-compatible `GET /models` response (`{ data: [...] }` or a bare
 * array) into endpoint models. Entries without an id and models that cannot chat are skipped;
 * missing limits get conservative defaults the user can correct before saving.
 */
export function parseByokEndpointModelsResponse(response: unknown): ByokEndpointModel[] {
  const models: ByokEndpointModel[] = [];
  const ids = new Set<string>();
  const internalIds = new Set<string>();
  for (const entry of modelEntries(response)) {
    if (models.length >= MAX_LISTED_MODELS) break;
    if (!isJsonObject(entry) || !isChatModel(entry)) continue;
    const internalId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!internalId || internalId.length > MAX_INTERNAL_ID_LENGTH || internalIds.has(internalId)) {
      continue;
    }
    const baseId = toByokEndpointModelId(internalId);
    if (!baseId) continue;
    const id = uniqueModelId(baseId, ids);

    const contextLength =
      firstPositiveInteger(entry, [
        ['context_length'],
        ['context_window'],
        ['max_context_length'],
        ['max_input_tokens'],
        ['context_size'],
        ['top_provider', 'context_length'],
        ['max_model_len'],
      ]) ?? DEFAULT_CONTEXT_LENGTH;
    const maxCompletionTokens =
      firstPositiveInteger(entry, [
        ['max_completion_tokens'],
        ['max_output_tokens'],
        ['max_tokens'],
        ['top_provider', 'max_completion_tokens'],
        ['output_token_limit'],
      ]) ?? Math.min(DEFAULT_MAX_COMPLETION_TOKENS, contextLength);
    const rawName = [entry.display_name, entry.name].find(
      (value): value is string => typeof value === 'string' && value.trim() !== ''
    );
    const name = rawName?.trim().slice(0, MAX_NAME_LENGTH);

    ids.add(id);
    internalIds.add(internalId);
    models.push({
      id,
      internal_id: internalId,
      ...(name && name !== internalId && { name }),
      context_length: contextLength,
      max_completion_tokens: maxCompletionTokens,
      supports_image_input: supportsImageInput(entry),
    });
  }
  return models;
}
