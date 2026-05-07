import * as z from 'zod';

/**
 * Possible values for the OpenRouter `output_modalities` query parameter,
 * as observed at https://openrouter.ai/api/v1/models?output_modalities=all.
 */
export const OutputModalitySchema = z.enum([
  'audio',
  'embeddings',
  'image',
  'rerank',
  'speech',
  'text',
  'transcription',
  'video',
]);

export type OutputModality = z.infer<typeof OutputModalitySchema>;

/**
 * Subset of {@link OutputModalitySchema} currently accepted by our `/models`
 * endpoints. Other modalities are intentionally rejected for now.
 */
export const SupportedOutputModalitySchema = z.enum(['embeddings']);

export type SupportedOutputModality = z.infer<typeof SupportedOutputModalitySchema>;
