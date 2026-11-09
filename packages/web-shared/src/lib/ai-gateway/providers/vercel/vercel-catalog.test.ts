import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import {
  getVercelCatalog,
  resetVercelCatalogCache,
  vercelCatalogSource,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog';

function catalogModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'language',
    created: 1_790_000_000,
    context_window: 128_000,
    modalities: { input: ['text'], output: ['text'] },
    pricing: { input: '0.000001', output: '0.000002' },
    ...overrides,
  };
}

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(async () => {
  resetVercelCatalogCache();
  await db.delete(ai_gateway_metadata_cache).where(sql`true`);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ data: [catalogModel('vendor/live')] }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getVercelCatalog', () => {
  it('reads the stored Vercel model list without fetching it', async () => {
    await db.insert(ai_gateway_metadata_cache).values({
      url: vercelCatalogSource.url,
      data: {
        data: [
          catalogModel('vendor/chat'),
          catalogModel('vendor/image', { modalities: { input: ['text'], output: ['image'] } }),
          catalogModel('vendor/embedding', { type: 'embedding' }),
          { id: 'vendor/broken' },
        ],
      },
    });

    const catalog = await getVercelCatalog();

    expect([...catalog.keys()]).toEqual(['vendor/chat']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the Vercel model list live only while no usable row is stored', async () => {
    await db
      .insert(ai_gateway_metadata_cache)
      .values({ url: vercelCatalogSource.url, data: { models: 'unexpected' } });

    const catalog = await getVercelCatalog();

    expect([...catalog.keys()]).toEqual(['vendor/live']);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/models',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('throws when no row is stored and Vercel answers with an error', async () => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 503 }));

    await expect(getVercelCatalog()).rejects.toThrow(
      'Fetching https://ai-gateway.vercel.sh/v1/models failed: 503'
    );
  });
});
