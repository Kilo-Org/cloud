import type { DirectByokModelFlag } from './types';
import * as z from 'zod';

export const ByokModelModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

export const OpenAICompatibleModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      max_model_len: z.number().optional(),
      max_output_length: z.number().optional(),
      input_modalities: z.array(ByokModelModalitySchema).optional(),
      supported_features: z.array(z.string()).optional(),
    })
  ),
});

export type OpenAICompatibleByokModel = {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  input_modalities?: ReadonlyArray<z.infer<typeof ByokModelModalitySchema>>;
  flags?: ReadonlyArray<DirectByokModelFlag>;
};

function shortenDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1).trim() : value;
}

export function parseOpenAICompatibleProviderModels(entry: unknown): OpenAICompatibleByokModel[] {
  const parsed = OpenAICompatibleModelsResponseSchema.parse(entry);
  return parsed.data
    .filter(model => !model.supported_features || model.supported_features.includes('tools'))
    .map(model => ({
      id: model.id,
      name: shortenDisplayName(model.name),
      context_length: model.context_length ?? model.max_model_len,
      max_completion_tokens: model.max_output_length,
      input_modalities: model.input_modalities,
      flags: ['reasoning'],
    }));
}
