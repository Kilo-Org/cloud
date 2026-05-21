import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getOpenRouterTranscriptionModels } from '@/lib/ai-gateway/providers/openrouter';
import { createMockResponse, mockOpenRouterModels } from '@/tests/helpers/openrouter-models.helper';

const originalFetch = global.fetch;

describe('OpenRouter transcription model fetcher', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches transcription models with output_modalities=transcription', async () => {
    await getOpenRouterTranscriptionModels();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('output_modalities=transcription'),
      expect.any(Object)
    );
  });
});
