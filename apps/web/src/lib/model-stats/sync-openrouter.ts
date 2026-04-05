import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import type { OpenRouterModel as OpenRouterApiModel } from '@/lib/providers/openrouter/openrouter-types';

/**
 * Convert per-token price to per-million-tokens price
 * OpenRouter provides prices like "0.00000039" (per token)
 * We store as "0.39" (per million tokens) for better precision in the database
 */
function toPricePerMillion(perTokenPrice: string | number | undefined): string | null {
  if (perTokenPrice === undefined || perTokenPrice === null) return null;
  const num = Number(perTokenPrice);
  if (isNaN(num)) return null;
  // Multiply by 1,000,000 to convert from per-token to per-million
  return String(num * 1_000_000);
}

export type SyncOpenRouterResult = {
  newModels: string[];
  updatedModels: string[];
  totalProcessed: number;
};

/**
 * Sync OpenRouter model data to the model_stats table
 *
 * This function:
 * 1. Ensures all preferred models exist in the model_stats table (creating or updating them)
 * 2. Updates OpenRouter data for any other models already in the database
 * 3. Sets isActive=true for preferred models
 *
 * @param allModels - All models from OpenRouter API
 * @param preferredModelIds - List of preferred model IDs that should be active
 * @returns Summary of sync operation
 */
export async function syncOpenRouterModels(
  allModels: OpenRouterModel[],
  preferredModelIds: string[]
): Promise<SyncOpenRouterResult> {
  // Create a map for quick lookup
  const allModelsMap = new Map(allModels.map(model => [model.id, model]));

  // Get preferred models data
  const preferredModelData = allModels.filter(model => preferredModelIds.includes(model.id));

  // Get ALL existing model stats from database (not just preferred ones)
  const existingStats = await db.select().from(modelStats);
  const existingStatsMap = new Map(existingStats.map(stat => [stat.openrouterId, stat]));

  const newModels: string[] = [];
  const updatedModels: string[] = [];
  const modelsToInsert: Array<typeof modelStats.$inferInsert> = [];
  const modelsToUpdate: Array<{ id: string; data: Partial<typeof modelStats.$inferInsert> }> = [];

  // Step 1: Process preferred models (ensure they exist and are active)
  for (const model of preferredModelData) {
    const existing = existingStatsMap.get(model.id);
    const isRecommended = preferredModelIds.includes(model.id);

    if (existing) {
      // Update existing preferred model - set isActive=true and update data
      modelsToUpdate.push({
        id: existing.id,
        data: {
          isActive: true,
          isRecommended,
          name: model.name,
          description: model.description,
          priceInput: toPricePerMillion(model.pricing?.prompt),
          priceOutput: toPricePerMillion(model.pricing?.completion),
          contextLength: model.context_length ?? null,
          maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
          inputModalities: model.architecture?.input_modalities ?? null,
          openrouterData: sql`${JSON.stringify(model)}::jsonb` as unknown as OpenRouterApiModel,
        },
      });
      updatedModels.push(model.id);
    } else {
      // Insert new preferred model
      modelsToInsert.push({
        isActive: true,
        isRecommended,
        openrouterId: model.id,
        slug: generateSlug(model.id),
        name: model.name,
        description: model.description,
        modelCreator: extractCreator(model.id),
        creatorSlug: extractCreatorSlug(model.id),
        priceInput: toPricePerMillion(model.pricing?.prompt),
        priceOutput: toPricePerMillion(model.pricing?.completion),
        contextLength: model.context_length ?? null,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
        inputModalities: model.architecture?.input_modalities ?? null,
        openrouterData: sql`${JSON.stringify(model)}::jsonb` as unknown as OpenRouterApiModel,
      });
      newModels.push(model.id);
    }
  }

  // Step 2: Update OpenRouter data for any other models already in the database
  for (const existingStat of existingStats) {
    // Skip if we already processed this as a preferred model
    if (preferredModelIds.includes(existingStat.openrouterId)) {
      continue;
    }

    const updatedModelData = allModelsMap.get(existingStat.openrouterId);
    if (updatedModelData) {
      const isRecommended = preferredModelIds.includes(updatedModelData.id);
      modelsToUpdate.push({
        id: existingStat.id,
        data: {
          // Note: NOT updating isActive - preserve user's setting
          isRecommended,
          name: updatedModelData.name,
          description: updatedModelData.description,
          priceInput: toPricePerMillion(updatedModelData.pricing?.prompt),
          priceOutput: toPricePerMillion(updatedModelData.pricing?.completion),
          contextLength: updatedModelData.context_length ?? null,
          maxOutputTokens: updatedModelData.top_provider?.max_completion_tokens ?? null,
          inputModalities: updatedModelData.architecture?.input_modalities ?? null,
          openrouterData:
            sql`${JSON.stringify(updatedModelData)}::jsonb` as unknown as OpenRouterApiModel,
        },
      });
      updatedModels.push(updatedModelData.id);
    }
  }

  // Execute batch operations
  const operations: Array<Promise<unknown>> = [];

  // Batch insert new models
  if (modelsToInsert.length > 0) {
    operations.push(db.insert(modelStats).values(modelsToInsert));
  }

  // Batch update existing models
  if (modelsToUpdate.length > 0) {
    operations.push(
      ...modelsToUpdate.map(({ id, data }) =>
        db.update(modelStats).set(data).where(eq(modelStats.id, id))
      )
    );
  }

  await Promise.all(operations);

  return {
    newModels,
    updatedModels,
    totalProcessed: newModels.length + updatedModels.length,
  };
}

/**
 * Generate a URL-friendly slug from the model ID
 */
function generateSlug(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extract the creator/provider name from the model ID
 * e.g., "anthropic/claude-sonnet-4.5" -> "anthropic"
 */
function extractCreator(modelId: string): string {
  const parts = modelId.split('/');
  return parts.length > 1 ? parts[0] : 'unknown';
}

/**
 * Extract and format the creator slug from the model ID
 */
function extractCreatorSlug(modelId: string): string {
  return extractCreator(modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}
