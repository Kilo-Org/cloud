import { afterEach, describe, expect, it } from '@jest/globals';
import { getVercelCatalog } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog';
import { createMockResponse } from '@kilocode/web-shared/tests/helpers/openrouter-models.helper';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('getVercelCatalog', () => {
  it('fetches the Vercel model list through the shared fetch cache', async () => {
    const fetchMock = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [
              {
                id: 'vendor/model',
                type: 'language',
                created: 1_790_000_000,
                context_window: 128_000,
                modalities: { input: ['text'], output: ['text'] },
                pricing: { input: '0.000001', output: '0.000002' },
              },
            ],
          },
        })
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const catalog = await getVercelCatalog();

    expect([...catalog.keys()]).toEqual(['vendor/model']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/models',
      expect.objectContaining({ cache: 'force-cache', next: { revalidate: 60 } })
    );
  });

  it('throws when Vercel answers with an error', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(createMockResponse({ ok: false, status: 503 }))
    ) as unknown as typeof fetch;

    await expect(getVercelCatalog()).rejects.toThrow(
      'Fetching Vercel AI Gateway models failed: 503'
    );
  });
});
