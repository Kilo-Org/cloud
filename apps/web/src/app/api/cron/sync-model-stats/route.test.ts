let mockEnabled = false;
let mockCronSecret: string | undefined = 'cron-secret';

jest.mock('@/lib/config.server', () => ({
  get CRON_SECRET() {
    return mockCronSecret;
  },
  get ENKRYPT_SYNC_ENABLED() {
    return mockEnabled;
  },
}));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getRawOpenRouterModels: jest.fn(),
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/model-stats/sync-artificial-analysis', () => ({
  syncArtificialAnalysisBenchmarks: jest.fn(),
}));
jest.mock('@/lib/model-stats/sync-openrouter', () => ({ syncOpenRouterModels: jest.fn() }));
jest.mock('@/lib/model-stats/sync-internal-data', () => ({ syncInternalUsageStats: jest.fn() }));
jest.mock('@/lib/model-stats/model-stats-cache', () => ({
  invalidateModelStatsCache: jest.fn(),
}));
jest.mock('@/lib/model-stats/sync-enkrypt', () => ({ syncEnkryptBenchmarks: jest.fn() }));
jest.mock('@/lib/ai-gateway/monitored-models', () => ({ getMonitoredModels: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  getEnhancedOpenRouterModels,
  getRawOpenRouterModels,
} from '@/lib/ai-gateway/providers/openrouter';
import { getMonitoredModels } from '@/lib/ai-gateway/monitored-models';
import { ENKRYPT_MODEL_MAPPINGS } from '@/lib/model-stats/enkrypt-identity';
import { syncArtificialAnalysisBenchmarks } from '@/lib/model-stats/sync-artificial-analysis';
import { syncInternalUsageStats } from '@/lib/model-stats/sync-internal-data';
import { syncOpenRouterModels } from '@/lib/model-stats/sync-openrouter';
import type { SyncOpenRouterResult } from '@/lib/model-stats/sync-openrouter';
import { invalidateModelStatsCache } from '@/lib/model-stats/model-stats-cache';
import { syncEnkryptBenchmarks } from '@/lib/model-stats/sync-enkrypt';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  buildScheduledJobFailureEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

function catalogModel(id: string): OpenRouterModel {
  return {
    id,
    name: `Synthetic ${id}`,
    created: 0,
    description: 'Synthetic catalog metadata',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: '' },
    top_provider: { is_moderated: false, max_completion_tokens: 4096 },
    pricing: { prompt: '0.000002', completion: '0.000003' },
    context_length: 8192,
  };
}

function request(authorization: string | undefined = 'Bearer cron-secret') {
  return new NextRequest('http://localhost/api/cron/sync-model-stats', {
    headers: authorization ? { authorization } : {},
  });
}

function expectExistingSyncCalls() {
  expect(getRawOpenRouterModels).toHaveBeenCalledTimes(1);
  expect(getRawOpenRouterModels).toHaveBeenCalledWith();
  expect(getEnhancedOpenRouterModels).toHaveBeenCalledTimes(1);
  expect(getEnhancedOpenRouterModels).toHaveBeenCalledWith();
  expect(getMonitoredModels).toHaveBeenCalledTimes(1);
  expect(syncOpenRouterModels).toHaveBeenCalledTimes(1);
  expect(syncArtificialAnalysisBenchmarks).toHaveBeenCalledTimes(1);
  expect(syncInternalUsageStats).toHaveBeenCalledTimes(1);
  expect(invalidateModelStatsCache).toHaveBeenCalledTimes(1);
  expect(jest.mocked(invalidateModelStatsCache).mock.invocationCallOrder[0]).toBeLessThan(
    mockEmitScheduledJobEvent.mock.invocationCallOrder[0]
  );
}

describe('GET /api/cron/sync-model-stats', () => {
  const monitoredModel = catalogModel('fixture/monitored');
  let mockFetch: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled = false;
    mockCronSecret = 'cron-secret';
    mockFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [monitoredModel] });
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [monitoredModel] });
    jest.mocked(getMonitoredModels).mockResolvedValue([monitoredModel.id]);
    jest.mocked(syncArtificialAnalysisBenchmarks).mockReset().mockResolvedValue(undefined);
    jest.mocked(syncInternalUsageStats).mockReset().mockResolvedValue(undefined);
    jest.mocked(invalidateModelStatsCache).mockReset();
    jest
      .mocked(syncOpenRouterModels)
      .mockReset()
      .mockResolvedValue({
        newModels: [monitoredModel.id],
        updatedModels: [],
        totalProcessed: 1,
      });
  });

  afterEach(() => {
    expect(mockFetch).not.toHaveBeenCalled();
    expect(syncEnkryptBenchmarks).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('emits a success event with aggregate model counters', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      duration: expect.stringMatching(/^\d+ms$/),
      newModels: 1,
      updatedModels: 0,
      totalProcessed: 1,
      newModelIds: [monitoredModel.id],
      timestamp: expect.any(String),
    });
    expect(syncOpenRouterModels).toHaveBeenCalledWith([monitoredModel], [monitoredModel.id]);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      preferred_model_count: 1,
      total_processed: 1,
      new_model_count: 1,
      updated_model_count: 0,
    });
    expectExistingSyncCalls();
  });

  it.each(['none', 'benchmarks', 'usage'] as const)(
    'invalidates once after all syncs settle, before emitting or responding (failure: %s)',
    async failure => {
      const writes: string[] = [];
      const catalogStarted = Promise.withResolvers<void>();
      const catalogFinished = Promise.withResolvers<SyncOpenRouterResult>();
      const usageStarted = Promise.withResolvers<void>();
      const usageFinished = Promise.withResolvers<void>();
      const error = new Error('Partial sync failure');
      jest.mocked(syncOpenRouterModels).mockImplementationOnce(async () => {
        catalogStarted.resolve();
        const result = await catalogFinished.promise;
        writes.push('catalog');
        return result;
      });
      jest.mocked(syncArtificialAnalysisBenchmarks).mockImplementationOnce(async () => {
        writes.push('benchmarks');
        if (failure === 'benchmarks') throw error;
        return undefined;
      });
      jest.mocked(syncInternalUsageStats).mockImplementationOnce(async () => {
        usageStarted.resolve();
        await usageFinished.promise;
        writes.push('usage');
        if (failure === 'usage') throw error;
      });
      jest.mocked(invalidateModelStatsCache).mockImplementationOnce(() => {
        writes.push('invalidate');
      });

      const responsePromise = GET(request());
      await catalogStarted.promise;
      expect(syncArtificialAnalysisBenchmarks).not.toHaveBeenCalled();
      expect(syncInternalUsageStats).not.toHaveBeenCalled();
      expect(invalidateModelStatsCache).not.toHaveBeenCalled();
      expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();

      catalogFinished.resolve({
        newModels: [monitoredModel.id],
        updatedModels: [],
        totalProcessed: 1,
      });
      await usageStarted.promise;
      expect(writes).toEqual(['catalog', 'benchmarks']);
      expect(invalidateModelStatsCache).not.toHaveBeenCalled();
      expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();

      usageFinished.resolve();
      const response = await responsePromise;
      expect(response.status).toBe(failure === 'none' ? 200 : 500);
      expect(writes).toEqual(['catalog', 'benchmarks', 'usage', 'invalidate']);
      expectExistingSyncCalls();
      if (failure !== 'none') {
        expect(await response.json()).toEqual({
          success: false,
          error: 'Failed to sync model stats',
          message: error.message,
        });
        expect(buildScheduledJobFailureEvent).toHaveBeenCalledWith({ runId: 'run-id' }, error);
      }
    }
  );

  it('invalidates after a rejected catalog sync that may have partially written', async () => {
    const error = new Error('Partial catalog failure');
    jest.mocked(syncOpenRouterModels).mockRejectedValueOnce(error);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to sync model stats',
      message: error.message,
    });
    expect(syncArtificialAnalysisBenchmarks).not.toHaveBeenCalled();
    expect(syncInternalUsageStats).not.toHaveBeenCalled();
    expect(invalidateModelStatsCache).toHaveBeenCalledTimes(1);
    expect(jest.mocked(invalidateModelStatsCache).mock.invocationCallOrder[0]).toBeLessThan(
      mockEmitScheduledJobEvent.mock.invocationCallOrder[0]
    );
    expect(buildScheduledJobFailureEvent).toHaveBeenCalledWith({ runId: 'run-id' }, error);
  });

  it('does not enroll mapped or enhanced-only models when disabled, preserving the overlay', async () => {
    const raw = catalogModel('openai/gpt-oss-120b');
    const enhanced = {
      ...raw,
      name: 'Synthetic public name',
      pricing: { prompt: '0', completion: '0' },
    };
    const enhancedOnly = catalogModel('qwen/qwen3-8b');
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [monitoredModel, raw] });
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [enhanced, enhancedOnly] });

    expect((await GET(request())).status).toBe(200);
    expect(syncOpenRouterModels).toHaveBeenCalledWith(
      [monitoredModel, { ...raw, name: enhanced.name, pricing: enhanced.pricing }],
      [monitoredModel.id]
    );
    expectExistingSyncCalls();
  });

  it('enrolls only mapped public IDs, reuses raw metadata, and appends real enhanced-only records once', async () => {
    mockEnabled = true;
    const raw = catalogModel('openai/gpt-oss-120b');
    const suppressed = catalogModel('z-ai/glm-4.5');
    const enhanced = {
      ...raw,
      name: 'Synthetic public name',
      description: 'Not the raw description',
      context_length: 1234,
      pricing: { prompt: '0', completion: '0' },
    };
    const enhancedOnly = catalogModel('qwen/qwen3-8b');
    const unreviewed = catalogModel('fixture/unreviewed');
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [monitoredModel, raw, suppressed] });
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: [enhanced, enhancedOnly, enhancedOnly, unreviewed],
    });
    jest.mocked(syncOpenRouterModels).mockResolvedValue({
      newModels: [raw.id, enhancedOnly.id],
      updatedModels: [monitoredModel.id],
      totalProcessed: 3,
    });

    expect((await GET(request())).status).toBe(200);
    expect(syncOpenRouterModels).toHaveBeenCalledWith(
      [
        monitoredModel,
        { ...raw, name: enhanced.name, pricing: enhanced.pricing },
        suppressed,
        enhancedOnly,
      ],
      [monitoredModel.id],
      [raw.id, enhancedOnly.id]
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      preferred_model_count: 1,
      total_processed: 3,
      new_model_count: 2,
      updated_model_count: 1,
    });
    expectExistingSyncCalls();
  });

  it('keeps overlapping and enhanced-only monitored IDs separate without expanding preferred metrics', async () => {
    mockEnabled = true;
    const raw = catalogModel('openai/gpt-oss-120b');
    const enhancedOnly = catalogModel('qwen/qwen3-8b');
    const monitored = [raw.id, enhancedOnly.id];
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [raw] });
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [raw, enhancedOnly] });
    jest.mocked(getMonitoredModels).mockResolvedValue(monitored);

    expect((await GET(request())).status).toBe(200);
    expect(syncOpenRouterModels).toHaveBeenCalledWith([raw, enhancedOnly], monitored, monitored);
    expect(monitored).toEqual([raw.id, enhancedOnly.id]);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_model_count: 1 })
    );
    expectExistingSyncCalls();
  });

  it('uses all reviewed mappings without adding them to the monitored registry', async () => {
    mockEnabled = true;
    const models = ENKRYPT_MODEL_MAPPINGS.map(({ modelId }) => catalogModel(modelId));
    const ids = [...new Set(models.map(model => model.id))];
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [...models, ...models] });

    expect((await GET(request())).status).toBe(200);
    expect(ids).toHaveLength(70);
    expect(syncOpenRouterModels).toHaveBeenCalledWith(
      [monitoredModel, ...models],
      [monitoredModel.id],
      ids
    );
    expectExistingSyncCalls();
  });

  it('passes no additional targets when none of the mappings are publicly available', async () => {
    mockEnabled = true;
    const suppressed = catalogModel('openai/gpt-oss-120b');
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [monitoredModel, suppressed] });

    expect((await GET(request())).status).toBe(200);
    expect(syncOpenRouterModels).toHaveBeenCalledWith(
      [monitoredModel, suppressed],
      [monitoredModel.id],
      []
    );
    expectExistingSyncCalls();
  });

  it.each(['', 'Bearer invalid'])(
    'rejects unauthorized requests (%s) before doing work',
    async authorization => {
      mockEnabled = true;
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(createScheduledJobRun).not.toHaveBeenCalled();
      expect(getRawOpenRouterModels).not.toHaveBeenCalled();
      expect(getEnhancedOpenRouterModels).not.toHaveBeenCalled();
      expect(getMonitoredModels).not.toHaveBeenCalled();
      expect(syncOpenRouterModels).not.toHaveBeenCalled();
      expect(syncArtificialAnalysisBenchmarks).not.toHaveBeenCalled();
      expect(syncInternalUsageStats).not.toHaveBeenCalled();
      expect(invalidateModelStatsCache).not.toHaveBeenCalled();
      expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
    }
  );

  it('rejects requests when the cron secret is not configured', async () => {
    mockCronSecret = undefined;

    expect((await GET(request('Bearer undefined'))).status).toBe(401);
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(getRawOpenRouterModels).not.toHaveBeenCalled();
    expect(syncOpenRouterModels).not.toHaveBeenCalled();
    expect(invalidateModelStatsCache).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'raw'],
    [true, 'raw'],
    [false, 'enhanced'],
    [true, 'enhanced'],
    [false, 'monitored'],
    [true, 'monitored'],
  ] as const)(
    'emits a failure without invalidating when fetching fails before writes (enabled: %s, source: %s)',
    async (enabled, source) => {
      mockEnabled = enabled;
      const error = new Error('upstream failed');
      if (source === 'raw') jest.mocked(getRawOpenRouterModels).mockRejectedValueOnce(error);
      if (source === 'enhanced')
        jest.mocked(getEnhancedOpenRouterModels).mockRejectedValueOnce(error);
      if (source === 'monitored') jest.mocked(getMonitoredModels).mockRejectedValueOnce(error);

      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Failed to sync model stats',
        message: 'upstream failed',
      });
      expect(captureException).toHaveBeenCalledWith(error, {
        tags: { endpoint: 'cron/sync-model-stats' },
        extra: { action: 'syncing_model_stats' },
      });
      expect(buildScheduledJobFailureEvent).toHaveBeenCalledWith({ runId: 'run-id' }, error);
      expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
        outcome: 'failed',
        exception_name: 'Error',
      });
      expect(syncOpenRouterModels).not.toHaveBeenCalled();
      expect(syncArtificialAnalysisBenchmarks).not.toHaveBeenCalled();
      expect(syncInternalUsageStats).not.toHaveBeenCalled();
      expect(invalidateModelStatsCache).not.toHaveBeenCalled();
    }
  );
});
