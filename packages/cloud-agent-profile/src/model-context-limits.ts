import * as z from 'zod';

export const MAX_MODEL_CONTEXT_LIMITS = 50;
export const MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH = 200;
export const MIN_MODEL_CONTEXT_TOKENS = 1_000;
export const MAX_MODEL_CONTEXT_TOKENS = 10_000_000;

/**
 * Per-model context-window caps, keyed by gateway model id (for example
 * `openai/gpt-6.1-sol`). Each cap lowers the context budget Kilo manages the
 * model with, so the conversation is compacted before it grows past the cap.
 */
export const ModelContextLimitsSchema = z
  .record(
    z.string().min(1).max(MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH),
    z.number().int().min(MIN_MODEL_CONTEXT_TOKENS).max(MAX_MODEL_CONTEXT_TOKENS)
  )
  .refine(limits => Object.keys(limits).length <= MAX_MODEL_CONTEXT_LIMITS, {
    message: `Maximum ${MAX_MODEL_CONTEXT_LIMITS} model context limits allowed`,
  });

export type ModelContextLimits = z.infer<typeof ModelContextLimitsSchema>;

/**
 * Store the gateway model id without the `kilo/` provider prefix: it is the
 * key the runtime writes under `provider.kilo.models`, and the picker offers
 * ids without the prefix.
 */
export function normalizeModelContextLimits(limits: ModelContextLimits): ModelContextLimits {
  const normalized: ModelContextLimits = {};
  for (const [model, context] of Object.entries(limits)) {
    const id = model.trim().replace(/^kilo\//, '');
    if (id) normalized[id] = context;
  }
  return normalized;
}

export function hasModelContextLimits(limits: ModelContextLimits | undefined): boolean {
  return limits !== undefined && Object.keys(limits).length > 0;
}
