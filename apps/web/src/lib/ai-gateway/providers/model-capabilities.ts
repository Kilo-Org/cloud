import 'server-only';
import { AUTO_MODELS } from '@/lib/kilo-auto';
import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Returns whether a given model ID supports image input.
 *
 * Handles two cases:
 * - kilo-auto/* virtual models: checked via the AUTO_MODELS config (supports_images field)
 * - All other models: queried from the model_stats DB table (inputModalities column)
 *
 * Falls back to false (safe default) if the model is not found in either source.
 */
export async function modelSupportsImages(modelId: string): Promise<boolean> {
  const autoModel = AUTO_MODELS.find(m => m.id === modelId);
  if (autoModel !== undefined) {
    return autoModel.supports_images;
  }

  const row = await db
    .select({ inputModalities: modelStats.inputModalities })
    .from(modelStats)
    .where(eq(modelStats.openrouterId, modelId))
    .limit(1)
    .then(rows => rows[0]);

  if (row === undefined) {
    return false;
  }

  return (
    row.inputModalities?.some(modality => modality === 'image' || modality === 'image_url') ?? false
  );
}
