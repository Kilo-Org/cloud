import { asc, eq } from 'drizzle-orm';
import { model_experiment } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

const DEFAULT_CONTEXT_LENGTH = 200_000;

function toCreatedSeconds(createdAt: string): number {
  const ms = new Date(createdAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function convertExperimentModel(row: typeof model_experiment.$inferSelect): OpenRouterModel {
  return {
    id: row.public_model_id,
    name: row.name,
    created: toCreatedSeconds(row.created_at),
    description: row.description ?? row.name,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: DEFAULT_CONTEXT_LENGTH,
      max_completion_tokens: null,
    },
    pricing: {
      prompt: '0.0000000',
      completion: '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: '0.00000000',
      input_cache_write: '0.00000000',
    },
    context_length: DEFAULT_CONTEXT_LENGTH,
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
  };
}

export async function listAvailableExperimentModels(): Promise<OpenRouterModel[]> {
  const rows = await readDb
    .select()
    .from(model_experiment)
    .where(eq(model_experiment.status, 'active'))
    .orderBy(asc(model_experiment.public_model_id));
  return rows.map(convertExperimentModel);
}
