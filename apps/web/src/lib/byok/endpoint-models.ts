import { ByokEndpointModelIdSchema, type ByokEndpointModel } from '@kilocode/db/schema-types';
import { normalizeRawModel, type RawModel } from '@/lib/providers/direct-byok/models-dev';

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

/** Model kinds that `type` or `model_type` can name for a model that serves chat requests. */
const CHAT_MODEL_TYPES = new Set(['chat', 'completion', 'language', 'llm', 'text']);

/**
 * Ids of models that cannot serve chat requests. Providers such as OpenAI list them without any
 * type information, so the id is the only signal left.
 */
const NON_CHAT_MODEL_ID_PATTERNS = [
  /(^|[/:._-])(text-embedding|embed|embedding|embeddings|tts|whisper|dall-e|gpt-image|moderation|omni-moderation|davinci|babbage|sora|transcribe|rerank)(?![a-z])/,
  /-(realtime|audio-preview|audio|transcribe|tts)(-|$)/,
];

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

function isChatModel(entry: JsonObject, id: string): boolean {
  const types = [entry.type, entry.model_type].flatMap(type =>
    typeof type === 'string' ? [type.toLowerCase()] : []
  );
  if (types.some(type => NON_CHAT_MODEL_TYPES.has(type))) return false;
  const chatCapability = field(entry, 'capabilities', 'completion_chat');
  if (typeof chatCapability === 'boolean') return chatCapability;
  if (types.some(type => CHAT_MODEL_TYPES.has(type))) return true;
  const lowerId = id.toLowerCase();
  return !NON_CHAT_MODEL_ID_PATTERNS.some(pattern => pattern.test(lowerId));
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

/** The model a `GET /models` entry describes, in the shape direct BYOK model lists start from. */
function toRawModel(entry: JsonObject, internalId: string): RawModel {
  return {
    id: internalId,
    name: [entry.display_name, entry.name]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim(),
    context_length: firstPositiveInteger(entry, [
      ['context_length'],
      ['context_window'],
      ['max_context_length'],
      ['max_input_tokens'],
      ['context_size'],
      ['top_provider', 'context_length'],
      ['max_model_len'],
    ]),
    max_completion_tokens: firstPositiveInteger(entry, [
      ['max_completion_tokens'],
      ['max_output_tokens'],
      ['max_tokens'],
      ['top_provider', 'max_completion_tokens'],
      ['output_token_limit'],
    ]),
    input_modalities: supportsImageInput(entry) ? ['text', 'image'] : ['text'],
    // As for OpenAI-compatible direct BYOK providers: `/models` rarely says, and the flag only
    // offers reasoning efforts that the model's family supports.
    flags: ['reasoning'],
  };
}

/**
 * Reads the models of an OpenAI-compatible `GET /models` response (`{ data: [...] }` or a bare
 * array) into endpoint models. Entries without an id and models that cannot chat are skipped;
 * missing names and limits get the direct BYOK defaults, which the user can correct before saving.
 */
export function parseByokEndpointModelsResponse(response: unknown): ByokEndpointModel[] {
  const models: ByokEndpointModel[] = [];
  const ids = new Set<string>();
  const internalIds = new Set<string>();
  for (const entry of modelEntries(response)) {
    if (models.length >= MAX_LISTED_MODELS) break;
    if (!isJsonObject(entry)) continue;
    const internalId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (
      !internalId ||
      !isChatModel(entry, internalId) ||
      internalId.length > MAX_INTERNAL_ID_LENGTH ||
      internalIds.has(internalId)
    ) {
      continue;
    }
    const baseId = toByokEndpointModelId(internalId);
    if (!baseId) continue;
    const id = uniqueModelId(baseId, ids);
    const model = normalizeRawModel(toRawModel(entry, internalId));
    const name = model.name.trim().slice(0, MAX_NAME_LENGTH);

    ids.add(id);
    internalIds.add(internalId);
    models.push({
      id,
      internal_id: internalId,
      ...(name && { name }),
      ...(model.flags && { flags: model.flags }),
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
    });
  }
  return models;
}
