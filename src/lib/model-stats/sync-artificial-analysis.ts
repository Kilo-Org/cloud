import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, sql, isNotNull } from 'drizzle-orm';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import { ARTIFICIAL_ANALYSIS_API_KEY } from '@/lib/config.server';
import * as z from 'zod';

/**
 * Sync Artificial Analysis benchmarks
 *
 * Fetches benchmark data from Artificial Analysis API and updates the
 * benchmarks field in model_stats for ALL models that have an aaSlug set.
 *
 * Matching strategy:
 * 1. Query all models with aaSlug set in the database
 * 2. Match against AA API response using the aaSlug
 * 3. Update benchmarks for all matched models (not just preferred ones)
 */
export async function syncArtificialAnalysisBenchmarks() {
  if (!ARTIFICIAL_ANALYSIS_API_KEY) {
    console.log('[artificial-analysis] Skipping sync - API key not configured');
    return;
  }

  console.log('[artificial-analysis] Fetching benchmarks...');

  const aaModels = await fetchArtificialAnalysisModels();
  if (!aaModels || aaModels.length === 0) {
    console.warn('[artificial-analysis] No models returned from API');
    return;
  }

  console.log(`[artificial-analysis] Fetched ${aaModels.length} models from API`);

  // Fetch ALL models that have aaSlug set (not just preferred ones)
  const dbModels = await db.select().from(modelStats).where(isNotNull(modelStats.aaSlug));

  console.log(`[artificial-analysis] Found ${dbModels.length} models with aaSlug mappings`);

  const aaModelBySlug = new Map(
    aaModels.filter(model => model.slug).map(model => [model.slug, model])
  );

  const modelsToUpdate: Array<{
    id: string;
    data: {
      codingIndex: string | null;
      speedTokensPerSec: string | null;
      releaseDate: string | null;
      benchmarks: ReturnType<typeof sql>;
    };
  }> = [];
  const unmatchedModels: string[] = [];

  for (const dbModel of dbModels) {
    // Only process models that have an aaSlug set
    if (!dbModel.aaSlug) {
      unmatchedModels.push(`${dbModel.openrouterId} (no aaSlug set)`);
      continue;
    }

    const aaModel = aaModelBySlug.get(dbModel.aaSlug);

    if (aaModel) {
      const benchmarkData = extractBenchmarkData(aaModel);

      modelsToUpdate.push({
        id: dbModel.id,
        data: {
          codingIndex: benchmarkData.codingIndex ? String(benchmarkData.codingIndex) : null,
          speedTokensPerSec: benchmarkData.speedTokensPerSec
            ? String(benchmarkData.speedTokensPerSec)
            : null,
          releaseDate: aaModel.release_date || null,
          // JSONB merge: || operator merges objects, replacing the artificialAnalysis
          // key if it exists while preserving other benchmark sources (e.g., internal data)
          benchmarks: sql`
              COALESCE(${modelStats.benchmarks}, '{}'::jsonb) ||
              ${JSON.stringify({ artificialAnalysis: benchmarkData.benchmarks })}::jsonb
            `,
        },
      });
    } else {
      unmatchedModels.push(`${dbModel.openrouterId} (aaSlug: ${dbModel.aaSlug} not found in AA)`);
    }
  }

  // Execute batch updates
  if (modelsToUpdate.length > 0) {
    await Promise.all(
      modelsToUpdate.map(({ id, data }) =>
        db.update(modelStats).set(data).where(eq(modelStats.id, id))
      )
    );
    console.log(`[artificial-analysis] Updated ${modelsToUpdate.length} models with benchmarks`);
  } else {
    console.log('[artificial-analysis] No matching models found');
  }

  if (unmatchedModels.length > 0) {
    console.log(
      `[artificial-analysis] Models without mapping (${unmatchedModels.length}):`,
      unmatchedModels.slice(0, 10)
    );
  }

  return {
    success: true,
    matchedCount: modelsToUpdate.length,
    unmatchedCount: unmatchedModels.length,
  };
}

/**
 * Fetch models from Artificial Analysis API
 */
async function fetchArtificialAnalysisModels(): Promise<ArtificialAnalysisModel[]> {
  if (!ARTIFICIAL_ANALYSIS_API_KEY) {
    throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is not configured');
  }

  const response = await fetchWithBackoff(
    'https://artificialanalysis.ai/api/v2/data/llms/models',
    {
      headers: {
        'x-api-key': ARTIFICIAL_ANALYSIS_API_KEY,
      },
    },
    {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryResponse: r => r.status === 429 || r.status >= 500,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Artificial Analysis API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const rawData = await response.json();
  const parsedData = ArtificialAnalysisResponseSchema.parse(rawData);
  return parsedData.data ?? [];
}

/**
 * Extract benchmark data from AA model
 */
function extractBenchmarkData(aaModel: ArtificialAnalysisModel) {
  const lastUpdated = new Date().toISOString();
  const evals = aaModel.evaluations || {};

  return {
    codingIndex: evals.artificial_analysis_coding_index ?? null,
    speedTokensPerSec: aaModel.median_output_tokens_per_second ?? null,
    benchmarks: {
      codingIndex: evals.artificial_analysis_coding_index,
      liveCodeBench: evals.livecodebench,
      sciCode: evals.scicode,
      terminalBenchHard: evals.terminalbench_hard,
      lcr: evals.lcr,
      ifBench: evals.ifbench,
      timeToFirstTokenSeconds: aaModel.median_time_to_first_token_seconds,
      lastUpdated,
    },
  };
}

/**
 * Zod schema for Artificial Analysis API response
 */
const ArtificialAnalysisModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  release_date: z.string().optional(),
  model_creator: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
    })
    .optional(),
  evaluations: z
    .object({
      artificial_analysis_intelligence_index: z.number().nullable().optional(),
      artificial_analysis_coding_index: z.number().nullable().optional(),
      artificial_analysis_math_index: z.number().nullable().optional(),
      mmlu_pro: z.number().nullable().optional(),
      gpqa: z.number().nullable().optional(),
      hle: z.number().nullable().optional(),
      livecodebench: z.number().nullable().optional(),
      scicode: z.number().nullable().optional(),
      math_500: z.number().nullable().optional(),
      aime: z.number().nullable().optional(),
      aime_25: z.number().nullable().optional(),
      ifbench: z.number().nullable().optional(),
      lcr: z.number().nullable().optional(),
      terminalbench_hard: z.number().nullable().optional(),
      tau2: z.number().nullable().optional(),
    })
    .optional(),
  pricing: z
    .object({
      price_1m_blended_3_to_1: z.number().optional(),
      price_1m_input_tokens: z.number().optional(),
      price_1m_output_tokens: z.number().optional(),
    })
    .optional(),
  median_output_tokens_per_second: z.number().optional(),
  median_time_to_first_token_seconds: z.number().optional(),
  median_time_to_first_answer_token: z.number().optional(),
});

const ArtificialAnalysisResponseSchema = z.object({
  data: z.array(ArtificialAnalysisModelSchema).optional(),
});

type ArtificialAnalysisModel = z.infer<typeof ArtificialAnalysisModelSchema>;
