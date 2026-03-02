import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import type { ModelStats } from '@kilocode/db/schema';
import { randomUUID } from 'crypto';

export async function insertTestModelStats(data: Partial<ModelStats> = {}): Promise<ModelStats> {
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const now = new Date().toISOString();

  const testData = {
    id: data.id || randomUUID(),
    openrouterId: data.openrouterId || `openrouter/test-model-${randomSuffix}`,
    slug: data.slug || `test-slug-${randomSuffix}`,
    name: data.name || 'Test Model',
    isActive: data.isActive ?? true,
    openrouterData: data.openrouterData ?? {
      id: data.openrouterId || `openrouter/test-model-${randomSuffix}`,
      name: data.name || 'Test Model',
      created: Date.now(),
      description: 'Test model for testing purposes',
      context_length: 128000,
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        request: '0',
        image: '0',
      },
      top_provider: {
        context_length: 128000,
        max_completion_tokens: 4096,
        is_moderated: false,
      },
      per_request_limits: null,
    },
    benchmarks: data.benchmarks ?? null,
    chartData: data.chartData ?? null,
    aaSlug: data.aaSlug ?? null,
    codingIndex: data.codingIndex ?? null,
    speedTokensPerSec: data.speedTokensPerSec ?? null,
    releaseDate: data.releaseDate ?? null,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
  };

  const result = await db
    .insert(modelStats)
    .values(testData as ModelStats)
    .returning();
  return result[0];
}
