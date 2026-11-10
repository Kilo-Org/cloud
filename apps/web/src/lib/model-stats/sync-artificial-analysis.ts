import { db } from '@kilocode/web-shared/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, sql, isNotNull } from 'drizzle-orm';
import { fetchWithBackoff } from '@kilocode/web-shared/lib/fetchWithBackoff';
import { ARTIFICIAL_ANALYSIS_API_KEY } from '@kilocode/web-shared/lib/config.server';
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

// Legacy `/api/v2/data/llms/models` returns 410. Pro list is the field-compatible
// replacement; free keys get 403 and must use the free sibling.
const LANGUAGE_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models';
const LANGUAGE_MODELS_FREE_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
const MAX_MODEL_PAGES = 50;

async function fetchArtificialAnalysisModels(): Promise<ArtificialAnalysisModel[]> {
  if (!ARTIFICIAL_ANALYSIS_API_KEY) {
    throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is not configured');
  }

  const proModels = await fetchModelPages(LANGUAGE_MODELS_URL);
  if (proModels !== 'forbidden') return proModels;

  console.log('[artificial-analysis] Pro models endpoint returned 403, using free endpoint');
  const freeModels = await fetchModelPages(LANGUAGE_MODELS_FREE_URL);
  if (freeModels === 'forbidden') {
    throw new Error(
      'Artificial Analysis API error: 403 subscription does not cover language models'
    );
  }
  return freeModels;
}

async function fetchModelPages(url: string): Promise<ArtificialAnalysisModel[] | 'forbidden'> {
  const models: ArtificialAnalysisModel[] = [];

  for (let page = 1; page <= MAX_MODEL_PAGES; page++) {
    const response = await fetchWithBackoff(
      `${url}?page=${page}`,
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

    if (response.status === 403) return 'forbidden';

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Artificial Analysis API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const parsedData = ArtificialAnalysisResponseSchema.parse(await response.json());
    models.push(...(parsedData.data ?? []));
    if (!parsedData.pagination?.has_more) return models;
  }

  throw new Error(`Artificial Analysis API pagination exceeded ${MAX_MODEL_PAGES} pages`);
}

function extractBenchmarkData(aaModel: ArtificialAnalysisModel) {
  const lastUpdated = new Date().toISOString();
  const evals = aaModel.evaluations || {};
  // `performance` medians are null from 2026-12-10; v3 means are the replacement.
  const speedTokensPerSec =
    aaModel.performance?.median_output_tokens_per_second ??
    aaModel.performance_v3?.mean_output_tokens_per_second ??
    null;
  const timeToFirstTokenSeconds =
    aaModel.performance?.median_time_to_first_token_seconds ??
    aaModel.performance_v3?.mean_time_to_first_token_seconds;

  return {
    codingIndex: evals.artificial_analysis_coding_index ?? null,
    speedTokensPerSec,
    benchmarks: {
      codingIndex: evals.artificial_analysis_coding_index,
      sciCode: evals.scicode,
      terminalBenchHard: evals.terminalbench_hard,
      lcr: evals.aa_lcr,
      ifBench: evals.ifbench,
      timeToFirstTokenSeconds,
      lastUpdated,
    },
  };
}

const nullableNumber = z.number().nullable().optional();

const ArtificialAnalysisModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  release_date: z.string().nullable().optional(),
  evaluations: z
    .object({
      artificial_analysis_coding_index: nullableNumber,
      scicode: nullableNumber,
      terminalbench_hard: nullableNumber,
      aa_lcr: nullableNumber,
      ifbench: nullableNumber,
    })
    .optional(),
  performance: z
    .object({
      median_output_tokens_per_second: nullableNumber,
      median_time_to_first_token_seconds: nullableNumber,
    })
    .nullable()
    .optional(),
  performance_v3: z
    .object({
      mean_output_tokens_per_second: nullableNumber,
      mean_time_to_first_token_seconds: nullableNumber,
    })
    .nullable()
    .optional(),
});

const ArtificialAnalysisResponseSchema = z.object({
  data: z.array(ArtificialAnalysisModelSchema).optional(),
  pagination: z
    .object({
      has_more: z.boolean(),
    })
    .optional(),
});

type ArtificialAnalysisModel = z.infer<typeof ArtificialAnalysisModelSchema>;
