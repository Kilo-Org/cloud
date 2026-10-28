import * as z from 'zod';
import type { DirectByokModelFlag } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  ReasoningOptionSchema,
  type DirectByokModelEndpoint,
  type ReasoningOption,
} from '@kilocode/db/schema-types';
import { toLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';

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
