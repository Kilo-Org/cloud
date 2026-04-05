import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { posthogQuery } from '@/lib/posthog-query';

// Common model provider prefixes used for matching normalized model names
const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'x-ai',
  'qwen',
  'minimax',
  'kwaipilot',
  'z-ai',
  'mistralai',
] as const;

type ModeRankingRawResult = [string, number, string, number]; // [mode, rank, model, tokens]

interface ModeRankings {
  architect?: number;
  code?: number;
  ask?: number;
  debug?: number;
  orchestrator?: number;
}

interface ModelModeRankings {
  [modelId: string]: ModeRankings;
}

interface ModelTokenCounts {
  [modelId: string]: number; // Total tokens across all modes
}

interface WeeklyTokenDataPoint {
  date: string;
  tokens: number;
}

interface WeeklyTokenUsage {
  dataPoints: WeeklyTokenDataPoint[];
  lastUpdated: string;
}

interface ChartDataUpdate {
  modeRankings?: ModeRankings & {
    lastUpdated: string;
  };
  last7DaysTokens?: number;
  weeklyTokenUsage?: WeeklyTokenUsage;
}

interface ModelChartDataUpdates {
  [normalizedModelName: string]: ChartDataUpdate;
}

/**
 * Fetch mode rankings data from PostHog
 *
 * Queries PostHog for model usage across all modes in the last 7 days
 * and returns structured data ready for database updates
 */
async function fetchModeRankingsData(): Promise<ModelChartDataUpdates> {
  console.log('[sync-internal-data] Fetching model usage data from PostHog...');

  // Query PostHog using the materialized view
  // This view is maintained in PostHog and provides the same data as the complex query
  // Explicitly select columns to avoid confusion from column order changes
  const response = await posthogQuery(
    'sync-model-stats-internal',
    `
select mode, rank, model, tokens
from models_by_modes_last_7_days
limit 100000
`
  );

  if (response.status === 'error') {
    console.error('[sync-internal-data] PostHog query failed:', response.error);
    throw new Error(`PostHog query failed: ${JSON.stringify(response.error)}`);
  }

  const results = (response.body.results ?? []) as ModeRankingRawResult[];
  console.log(`[sync-internal-data] Received ${results.length} results from PostHog`);

  console.log('[sync-internal-data] Sample results:', results.slice(0, 10));

  // Group results by model
  const modelRankings: ModelModeRankings = {};
  const modelTokens: ModelTokenCounts = {};
  const modesSeen = new Set<string>();
  for (const [mode, rank, model, tokens] of results) {
    modesSeen.add(mode);
    if (!modelRankings[model]) {
      modelRankings[model] = {};
    }
    modelRankings[model][mode as keyof ModeRankings] = rank;

    // Accumulate total tokens across all modes
    modelTokens[model] = (modelTokens[model] || 0) + tokens;
  }

  console.log('[sync-internal-data] Modes found in data:', Array.from(modesSeen));

  console.log(
    `[sync-internal-data] Processed rankings for ${Object.keys(modelRankings).length} unique models`
  );

  // Build the chart data updates object
  const lastUpdated = new Date().toISOString();
  const chartDataUpdates: ModelChartDataUpdates = {};

  for (const [normalizedModelName, rankings] of Object.entries(modelRankings)) {
    chartDataUpdates[normalizedModelName] = {
      modeRankings: { ...rankings, lastUpdated },
      last7DaysTokens: modelTokens[normalizedModelName] || 0,
    };
  }

  return chartDataUpdates;
}

/**
 * Fetch weekly token usage data from PostHog
 *
 * Queries PostHog for daily token usage per model over the last 7 days
 * and returns structured time-series data ready for charting
 */
async function fetchWeeklyTokenUsage(): Promise<ModelChartDataUpdates> {
  console.log('[sync-internal-data] Fetching weekly token usage data from PostHog...');

  // Query PostHog for daily token usage by model over the last 7 days
  // Explicitly select columns to avoid confusion from column order changes
  const response = await posthogQuery(
    'sync-model-stats-weekly-tokens',
    `
select date, model, tokens
from models_usage_by_week
limit 100000
`
  );

  if (response.status === 'error') {
    console.error('[sync-internal-data] PostHog weekly token query failed:', response.error);
    throw new Error(`PostHog query failed: ${JSON.stringify(response.error)}`);
  }

  const results = (response.body.results ?? []) as [string, string, number][]; // [date, model, tokens]
  console.log(`[sync-internal-data] Received ${results.length} weekly token results from PostHog`);

  console.log('[sync-internal-data] Sample weekly token results:', results.slice(0, 10));

  // Group results by model
  const modelWeeklyData: Record<string, WeeklyTokenDataPoint[]> = {};

  for (const [date, model, tokens] of results) {
    if (!modelWeeklyData[model]) {
      modelWeeklyData[model] = [];
    }
    modelWeeklyData[model].push({ date, tokens });
  }

  console.log(
    `[sync-internal-data] Processed weekly token data for ${Object.keys(modelWeeklyData).length} unique models`
  );

  // Build the chart data updates object
  const lastUpdated = new Date().toISOString();
  const chartDataUpdates: ModelChartDataUpdates = {};

  for (const [normalizedModelName, dataPoints] of Object.entries(modelWeeklyData)) {
    // Sort data points by date to ensure chronological order
    dataPoints.sort((a, b) => a.date.localeCompare(b.date));

    chartDataUpdates[normalizedModelName] = {
      weeklyTokenUsage: {
        dataPoints,
        lastUpdated,
      },
    };
  }

  return chartDataUpdates;
}

/**
 * Sync internal usage statistics from PostHog
 *
 * This function:
 * 1. Fetches model usage data from PostHog (mode rankings and weekly token usage)
 * 2. Matches normalized model names to database records
 * 3. Updates the chartData field in model_stats
 */
export async function syncInternalUsageStats(): Promise<void> {
  // Fetch mode rankings data from PostHog
  const chartDataUpdates = await fetchModeRankingsData();

  // Fetch weekly token usage data and merge it
  const weeklyTokenUsage = await fetchWeeklyTokenUsage();
  for (const [model, data] of Object.entries(weeklyTokenUsage)) {
    chartDataUpdates[model] = { ...chartDataUpdates[model], ...data };
  }

  // Get ALL existing model stats to match normalized model names to openrouterId
  // This ensures we update any model in the database, not just preferred ones
  const allModelStats = await db.select().from(modelStats);
  const modelStatsMap = new Map(allModelStats.map(stat => [stat.openrouterId, stat]));

  console.log(`[sync-internal-data] Found ${allModelStats.length} models in database`);

  // Track updates
  let updatedCount = 0;
  let skippedCount = 0;

  // Update each model's chartData with mode rankings
  for (const [normalizedModelName, updateData] of Object.entries(chartDataUpdates)) {
    // Try to find matching model in database
    // The normalized model name from PostHog might not exactly match openrouterId
    // We need to handle various cases like:
    // - "claude-sonnet-4.5" -> "anthropic/claude-sonnet-4.5"
    // - "grok-code-fast-1" -> "x-ai/grok-code-fast-1"
    // - etc.

    let matchingModel = modelStatsMap.get(normalizedModelName);

    // If no exact match, try with common provider prefixes
    if (!matchingModel) {
      for (const provider of MODEL_PROVIDERS) {
        const withProvider = `${provider}/${normalizedModelName}`;
        matchingModel = modelStatsMap.get(withProvider);
        if (matchingModel) break;
      }
    }

    // Try with :free suffix - any model might have this
    if (!matchingModel) {
      const withFreeSuffix = `${normalizedModelName}:free`;
      matchingModel = modelStatsMap.get(withFreeSuffix);
    }

    // Also try with provider prefix + :free suffix
    if (!matchingModel) {
      for (const provider of MODEL_PROVIDERS) {
        const withProviderAndSuffix = `${provider}/${normalizedModelName}:free`;
        matchingModel = modelStatsMap.get(withProviderAndSuffix);
        if (matchingModel) break;
      }
    }

    if (!matchingModel) {
      skippedCount++;
      continue;
    }

    // Update the model's chartData using JSONB merge
    // This preserves other chartData fields (like weeklyTokenUsage) while updating modeRankings and last7DaysTokens
    await db
      .update(modelStats)
      .set({
        chartData: sql`
          COALESCE(${modelStats.chartData}, '{}'::jsonb) ||
          ${JSON.stringify(updateData)}::jsonb
        `,
      })
      .where(eq(modelStats.id, matchingModel.id));

    updatedCount++;
  }

  console.log(
    `[sync-internal-data] Updated ${updatedCount} models, skipped ${skippedCount} (not found in database)`
  );
}
