jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

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
jest.mock('@/lib/ai-gateway/monitored-models', () => ({ getMonitoredModels: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import {
  getEnhancedOpenRouterModels,
  getRawOpenRouterModels,
} from '@/lib/ai-gateway/providers/openrouter';
import { getMonitoredModels } from '@/lib/ai-gateway/monitored-models';
import { syncArtificialAnalysisBenchmarks } from '@/lib/model-stats/sync-artificial-analysis';
import { syncInternalUsageStats } from '@/lib/model-stats/sync-internal-data';
import { syncOpenRouterModels } from '@/lib/model-stats/sync-openrouter';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

describe('GET /api/cron/sync-model-stats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits a success event with aggregate model counters', async () => {
    const model = {
      id: 'openai/gpt',
      name: 'GPT',
      created: 0,
      description: '',
      architecture: { input_modalities: [], output_modalities: [], tokenizer: '' },
      top_provider: { is_moderated: false },
      pricing: { prompt: '0', completion: '0' },
      context_length: 0,
    };
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [model] });
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [model] });
    jest.mocked(getMonitoredModels).mockResolvedValue(['openai/gpt']);
    jest.mocked(syncOpenRouterModels).mockResolvedValue({
      newModels: ['openai/gpt'],
      updatedModels: [],
      totalProcessed: 1,
    });
    jest.mocked(syncArtificialAnalysisBenchmarks).mockResolvedValue(undefined as never);
    jest.mocked(syncInternalUsageStats).mockResolvedValue();

    const response = await GET(
      new Request('http://localhost/api/cron/sync-model-stats', {
        headers: { authorization: 'Bearer cron-secret' },
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      preferred_model_count: 1,
      total_processed: 1,
      new_model_count: 1,
      updated_model_count: 0,
    });
  });

  it('emits a failure event before returning its existing error response', async () => {
    jest.mocked(getRawOpenRouterModels).mockRejectedValue(new Error('upstream failed'));

    const response = await GET(
      new Request('http://localhost/api/cron/sync-model-stats', {
        headers: { authorization: 'Bearer cron-secret' },
      }) as never
    );

    expect(response.status).toBe(500);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
