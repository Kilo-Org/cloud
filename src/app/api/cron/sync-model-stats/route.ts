import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { getRawOpenRouterModels, getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { syncArtificialAnalysisBenchmarks } from '@/lib/model-stats/sync-artificial-analysis';
import { syncOpenRouterModels } from '@/lib/model-stats/sync-openrouter';
import { syncInternalUsageStats } from '@/lib/model-stats/sync-internal-data';
import { CRON_SECRET } from '@/lib/config.server';
import { preferredModels } from '@/lib/models';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

const BETTERSTACK_HEARTBEAT_URL =
  'https://uptime.betterstack.com/api/v1/heartbeat/1zuL4cAH8Ui6JF9j8M3L8oAD';

/**
 * Vercel Cron Job: Sync Model Stats
 *
 * This endpoint runs periodically to update the model_stats table with:
 * - OpenRouter model data (pricing, specs, etc.)
 * - Artificial Analysis benchmarks
 * - Internal usage statistics from Posthog
 *
 * It ensures all models in the preferredModels list are tracked and marked as active.
 * It also updates OpenRouter data for any other models already in the database.
 * Note: Models are never automatically deactivated - only users can deactivate models.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[sync-model-stats] Starting model stats sync...');
    const startTime = Date.now();

    // Fetch all models from OpenRouter (raw, unfiltered data)
    const openRouterResponse = await getRawOpenRouterModels();
    const enhancedOpenRouterResponse = await getEnhancedOpenRouterModels({
      includeSlackbotOnly: true,
    });

    // Create a map of enhanced models for pricing lookup (includes Kilo free models with $0 pricing)
    const enhancedModelsMap = new Map(
      enhancedOpenRouterResponse.data.map(model => [model.id, model])
    );

    // Merge pricing from enhanced models into raw models
    // This ensures Kilo free models have their $0 pricing applied
    const allModels: OpenRouterModel[] = openRouterResponse.data.map(model => {
      const enhancedModel = enhancedModelsMap.get(model.id);
      if (enhancedModel) {
        return {
          ...model,
          pricing: enhancedModel.pricing,
          name: enhancedModel.name,
        };
      }
      return model;
    });

    const preferredModelData = allModels.filter(model => preferredModels.includes(model.id));

    console.log(
      `[sync-model-stats] Found ${preferredModelData.length} preferred models out of ${allModels.length} total`
    );

    // Sync OpenRouter model data to database
    const syncResult = await syncOpenRouterModels(allModels, preferredModels);
    const { newModels, updatedModels, totalProcessed } = syncResult;

    console.log(
      `[sync-model-stats] Synced ${totalProcessed} models: ${newModels.length} new, ${updatedModels.length} updated`
    );

    // Fetch and update Artificial Analysis benchmarks for ALL models with aaSlug
    await syncArtificialAnalysisBenchmarks();

    // Calculate and update internal usage statistics from Posthog
    await syncInternalUsageStats();

    const duration = Date.now() - startTime;
    const summary = {
      success: true,
      duration: `${duration}ms`,
      newModels: newModels.length,
      updatedModels: updatedModels.length,
      totalProcessed,
      newModelIds: newModels,
      timestamp: new Date().toISOString(),
    };

    console.log('[sync-model-stats] Sync completed:', summary);

    // Send heartbeat to BetterStack on success
    await fetch(BETTERSTACK_HEARTBEAT_URL);

    return NextResponse.json(summary);
  } catch (error) {
    console.error('[sync-model-stats] Error syncing model stats:', error);
    captureException(error, {
      tags: { endpoint: 'cron/sync-model-stats' },
      extra: {
        action: 'syncing_model_stats',
      },
    });

    // Send failure heartbeat to BetterStack
    await fetch(`${BETTERSTACK_HEARTBEAT_URL}/fail`);

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync model stats',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
