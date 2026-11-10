import { jest } from '@jest/globals';

const mockedFetch =
  jest.fn<typeof import('@kilocode/web-shared/lib/fetchWithBackoff').fetchWithBackoff>();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ARTIFICIAL_ANALYSIS_API_KEY: 'test-artificial-analysis-key',
}));

jest.mock('@kilocode/web-shared/lib/fetchWithBackoff', () => ({
  fetchWithBackoff: mockedFetch,
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';

const openrouterIds = ['aa-sync/matched', 'aa-sync/missing'];

async function syncArtificialAnalysisBenchmarks() {
  const loaded = await import('./sync-artificial-analysis');
  return loaded.syncArtificialAnalysisBenchmarks();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function model(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    release_date: '2026-08-18',
    evaluations: {
      artificial_analysis_coding_index: null,
      scicode: 0.59,
      terminalbench_hard: null,
      aa_lcr: 0.797,
      ifbench: null,
    },
    performance: {
      median_output_tokens_per_second: 80.07,
      median_time_to_first_token_seconds: 2.22,
    },
    performance_v3: {
      mean_output_tokens_per_second: 62.36,
      mean_time_to_first_token_seconds: 3.45,
    },
    ...overrides,
  };
}

afterEach(async () => {
  mockedFetch.mockReset();
  await db.delete(modelStats).where(inArray(modelStats.openrouterId, openrouterIds));
});

describe('syncArtificialAnalysisBenchmarks', () => {
  it('pages the pro language-models endpoint and stores the replacement fields', async () => {
    const matched = await insertTestModelStats({
      openrouterId: 'aa-sync/matched',
      aaSlug: 'glm-5-3',
      codingIndex: '12.00',
    });
    await insertTestModelStats({ openrouterId: 'aa-sync/missing', aaSlug: 'not-in-aa' });

    mockedFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [model('glm-5-3')],
          pagination: { has_more: true },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [model('other-model')],
          pagination: { has_more: false },
        })
      );

    await expect(syncArtificialAnalysisBenchmarks()).resolves.toEqual({
      success: true,
      matchedCount: 1,
      unmatchedCount: 1,
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls.map(call => call[0])).toEqual([
      'https://artificialanalysis.ai/api/v2/language/models?page=1',
      'https://artificialanalysis.ai/api/v2/language/models?page=2',
    ]);

    const [stored] = await db.select().from(modelStats).where(eq(modelStats.id, matched.id));
    expect(stored?.codingIndex).toBeNull();
    expect(stored?.speedTokensPerSec).toBe('80.07');
    expect(stored?.releaseDate).toBe('2026-08-18');
    expect(stored?.benchmarks?.artificialAnalysis).toMatchObject({
      sciCode: 0.59,
      lcr: 0.797,
      timeToFirstTokenSeconds: 2.22,
    });
    expect(stored?.benchmarks?.artificialAnalysis).not.toHaveProperty('liveCodeBench');
  });

  it('falls back to the free endpoint and performance v3 when pro returns 403', async () => {
    const matched = await insertTestModelStats({
      openrouterId: 'aa-sync/matched',
      aaSlug: 'glm-5-3',
    });

    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            model('glm-5-3', {
              evaluations: { artificial_analysis_coding_index: null },
              performance: {
                median_output_tokens_per_second: null,
                median_time_to_first_token_seconds: null,
              },
            }),
          ],
          pagination: { has_more: false },
        })
      );

    await expect(syncArtificialAnalysisBenchmarks()).resolves.toMatchObject({
      success: true,
      matchedCount: 1,
    });

    expect(mockedFetch.mock.calls.map(call => call[0])).toEqual([
      'https://artificialanalysis.ai/api/v2/language/models?page=1',
      'https://artificialanalysis.ai/api/v2/language/models/free?page=1',
    ]);

    const [stored] = await db.select().from(modelStats).where(eq(modelStats.id, matched.id));
    expect(stored?.speedTokensPerSec).toBe('62.36');
    expect(stored?.benchmarks?.artificialAnalysis?.timeToFirstTokenSeconds).toBe(3.45);
  });
});
