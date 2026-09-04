import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import {
  getRawOpenRouterModels,
  getEnhancedOpenRouterModels,
} from '@/lib/ai-gateway/providers/openrouter';
import { syncArtificialAnalysisBenchmarks } from '@/lib/model-stats/sync-artificial-analysis';
import { syncOpenRouterModels } from '@/lib/model-stats/sync-openrouter';
import { syncInternalUsageStats } from '@/lib/model-stats/sync-internal-data';
import { invalidateModelStatsCache } from '@/lib/model-stats/model-stats-cache';
import { CRON_SECRET, ENKRYPT_SYNC_ENABLED } from '@/lib/config.server';
import { ENKRYPT_MODEL_MAPPINGS } from '@/lib/model-stats/enkrypt-identity';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { getMonitoredModels } from '@/lib/ai-gateway/monitored-models';

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
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.sync_model_stats',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    console.log('[sync-model-stats] Starting model stats sync...');
    const startTime = Date.now();

    // Fetch all models from OpenRouter (raw, unfiltered data)
    const openRouterResponse = await getRawOpenRouterModels();
    const enhancedOpenRouterResponse = await getEnhancedOpenRouterModels();

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

    const monitoredModels = await getMonitoredModels();
    const preferredModelData = allModels.filter(model => monitoredModels.includes(model.id));

    console.log(
      `[sync-model-stats] Found ${preferredModelData.length} preferred models out of ${allModels.length} total`
    );

    const additionalModelIds = ENKRYPT_SYNC_ENABLED
      ? [...new Set(ENKRYPT_MODEL_MAPPINGS.map(({ modelId }) => modelId))].filter(modelId =>
          enhancedModelsMap.has(modelId)
        )
      : [];
    if (additionalModelIds.length > 0) {
      const rawModelIds = new Set(allModels.map(model => model.id));
      for (const modelId of additionalModelIds) {
        const enhancedModel = enhancedModelsMap.get(modelId);
        if (!rawModelIds.has(modelId) && enhancedModel) {
          allModels.push(enhancedModel);
        }
      }
    }

    const catalogSync = ENKRYPT_SYNC_ENABLED
      ? syncOpenRouterModels(allModels, monitoredModels, additionalModelIds)
      : syncOpenRouterModels(allModels, monitoredModels);
    const [catalogResult, ...otherResults] = await Promise.allSettled([
      catalogSync,
      catalogSync.then(() => syncArtificialAnalysisBenchmarks()),
      catalogSync.then(() => syncInternalUsageStats()),
    ]);
    invalidateModelStatsCache();

    if (catalogResult.status === 'rejected') throw catalogResult.reason;
    for (const result of otherResults) {
      if (result.status === 'rejected') throw result.reason;
    }
    const { newModels, updatedModels, totalProcessed } = catalogResult.value;

    console.log(
      `[sync-model-stats] Synced ${totalProcessed} models: ${newModels.length} new, ${updatedModels.length} updated`
    );

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

    console.log('[sync-model-stats] Sync completed', {
      duration,
      newModelCount: newModels.length,
      totalProcessed,
      updatedModelCount: updatedModels.length,
    });
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        preferred_model_count: preferredModelData.length,
        total_processed: totalProcessed,
        new_model_count: newModels.length,
        updated_model_count: updatedModels.length,
      })
    );

    return NextResponse.json(summary);
  } catch (error) {
    console.error('[sync-model-stats] Error syncing model stats');
    captureException(error, {
      tags: { endpoint: 'cron/sync-model-stats' },
      extra: {
        action: 'syncing_model_stats',
      },
    });

    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));

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
