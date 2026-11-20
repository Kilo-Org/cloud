import * as z from 'zod';
import type {
  DirectByokModel,
  DirectByokModelFlag,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  ReasoningOptionSchema,
  type DirectByokModelEndpoint,
  type ReasoningOption,
} from '@kilocode/db/schema-types';
import { toLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import {
  assertMinimumCount,
  getMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

export const ModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOptionSchema).optional().catch(undefined),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional().catch(undefined),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  modalities: z
    .object({
      input: z.array(ModalitySchema).optional(),
      output: z.array(ModalitySchema).optional(),
    })
    .optional(),
  tool_call: z.boolean().optional(),
  provider: z
    .object({ npm: z.string().optional(), api: z.string().optional() })
    .optional()
    .catch(undefined),
  canonical_model_id: z.string().optional().catch(undefined),
});

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;

export const ModelsDevProviderSchema = z.object({
  models: z.record(z.string(), ModelsDevModelSchema),
});

export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;

export const ModelsDevCatalogSchema = z.record(z.string(), z.unknown());

export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

export const modelsDevCatalogSource: MetadataSource<ModelsDevCatalog> = {
  url: 'https://models.dev/api.json',
  parse: raw => {
    const catalog = ModelsDevCatalogSchema.parse(raw);
    assertMinimumCount(modelsDevCatalogSource.url, Object.keys(catalog).length, 10);
    return catalog;
  },
};

export function loadModelsDevCatalog(): Promise<ModelsDevCatalog> {
  return getMetadata(modelsDevCatalogSource, readDb);
}

export type RawModel = {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  input_modalities?: ReadonlyArray<z.infer<typeof ModalitySchema>>;
  flags?: ReadonlyArray<DirectByokModelFlag>;
  reasoning_options?: ReasoningOption[];
  endpoint?: DirectByokModelEndpoint;
};

const DEFAULT_CONTEXT_LENGTH = 200_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;

/**
 * A fetched model as BYOK model lists store it: a missing name or limit gets a default, image
 * input sets the `vision` flag, and the max output never exceeds the context window.
 */
export function normalizeRawModel(raw: RawModel): Omit<DirectByokModel, 'catalog_model_id'> {
  const name = raw.name ?? shortenDisplayName(raw.id);
  const context_length = raw.context_length ?? DEFAULT_CONTEXT_LENGTH;
  const flags = new Set(raw.flags);
  if (raw.input_modalities?.includes('image')) flags.add('vision');
  const max_completion_tokens = Math.min(
    raw.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    context_length
  );
  return {
    id: raw.id,
    name,
    flags: flags.size > 0 ? [...flags] : undefined,
    context_length,
    max_completion_tokens,
    reasoning_options: raw.reasoning_options,
    ...(raw.endpoint && { endpoint: raw.endpoint }),
  };
}

export function shortenDisplayName(id: string): string;
export function shortenDisplayName(id: string | undefined): string | undefined;
export function shortenDisplayName(id: string | undefined) {
  if (!id) return undefined;
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1).trim() : id;
}

// models.dev `[]` and effort values the gateway cannot send are treated as unknown, so that
// reasoning models fall back to the model-name defaults when served.
function supportedReasoningOptions(
  options: ReasoningOption[] | undefined
): ReasoningOption[] | undefined {
  return options?.length && toLegacyVariants(options, undefined) ? options : undefined;
}

export function isUsableModelsDevModel(model: ModelsDevModel) {
  return (
    model.status !== 'deprecated' &&
    (!model.modalities?.output || model.modalities.output.includes('text')) &&
    model.tool_call !== false &&
    (!model.modalities?.input || model.modalities.input.includes('text'))
  );
}

export function toRawModel(model: ModelsDevModel): RawModel {
  return {
    id: model.id,
    name: shortenDisplayName(model.name),
    context_length: model.limit?.context,
    max_completion_tokens: model.limit?.output,
    input_modalities: model.modalities?.input,
    flags: model.reasoning ? ['reasoning'] : undefined,
    reasoning_options: supportedReasoningOptions(model.reasoning_options),
  };
}
