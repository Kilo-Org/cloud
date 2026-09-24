import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as ExternalModelCache from './external-model-cache';
import type * as Drizzle from '@/lib/drizzle';

const mockRows: { data: unknown; synced_at: string }[] = [];
const mockWrites: { source: string; data: unknown; synced_at: string }[] = [];

jest.mock('@/lib/drizzle', () => ({
  readDb: { select: jest.fn() },
  db: { insert: jest.fn() },
}));

const {
  getCachedOpenAiServedModels,
  getCachedOpenRouterModels,
  invalidateCachedOpenRouterModels,
  saveOpenAiServedModels,
  saveOpenRouterModels,
} = jest.requireActual<typeof ExternalModelCache>('./external-model-cache');
const { db, readDb } = jest.requireMock<typeof Drizzle>('@/lib/drizzle');

const catalogModel = {
  id: 'vendor/model',
  name: 'Model',
  created: 1,
  description: 'Description',
  architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
  top_provider: { is_moderated: false },
  pricing: { prompt: '0', completion: '0' },
  context_length: 1000,
};

describe('external model cache', () => {
  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    invalidateCachedOpenRouterModels();
    mockRows.length = 0;
    mockWrites.length = 0;
    (readDb.select as jest.Mock).mockClear();
    (readDb.select as jest.Mock).mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => mockRows }) }),
    }));
    (db.insert as jest.Mock).mockImplementation(() => ({
      values: (row: { source: string; data: unknown; synced_at: string }) => ({
        onConflictDoUpdate: async () => {
          mockWrites.push(row);
        },
      }),
    }));
  });

  it('stores a validated OpenRouter catalog and removes upstream enkrypt', async () => {
    const data = Array.from({ length: 100 }, (_, index) => ({
      ...catalogModel,
      id: `vendor/model-${index}`,
      enkrypt: { untrusted: true },
    }));

    await expect(saveOpenRouterModels({ data })).resolves.toBe(true);
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].source).toContain('openrouter:');
    expect(mockWrites[0].data).toEqual({
      data: data.map(model => ({ ...catalogModel, id: model.id })),
    });
  });

  it('never replaces a good row with malformed or suspiciously small responses', async () => {
    await expect(saveOpenRouterModels({ data: [] })).resolves.toBe(false);
    await expect(
      saveOpenRouterModels({ data: Array.from({ length: 100 }, () => ({ id: 'broken' })) })
    ).resolves.toBe(false);
    await expect(saveOpenAiServedModels('partner-key', {})).resolves.toBe(false);
    await expect(saveOpenAiServedModels('partner-key', { data: [] })).resolves.toBe(true);
    await expect(saveOpenAiServedModels('partner-key', { data: [{ id: 123 }] })).resolves.toBe(
      false
    );
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].data).toEqual({ data: [] });
  });

  it('scopes OpenAI served lists to the partner key without storing the key', async () => {
    await expect(
      saveOpenAiServedModels('partner-key', { data: [{ id: 'gpt-5-nano' }] })
    ).resolves.toBe(true);
    await saveOpenAiServedModels('other-key', { data: [{ id: 'gpt-5-nano' }] });

    expect(mockWrites[0].source).not.toBe(mockWrites[1].source);
    expect(JSON.stringify(mockWrites)).not.toContain('partner-key');
    expect(mockWrites[0].data).toEqual({ data: [{ id: 'gpt-5-nano' }] });
  });

  it('ignores stale and corrupt rows', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-29T01:20:00Z').getTime());
    mockRows.push({
      data: { data: [{ id: 'gpt-5-nano' }] },
      synced_at: '2026-04-29 01:16:12.945+00',
    });
    await expect(getCachedOpenAiServedModels('partner-key')).resolves.toEqual(
      new Set(['gpt-5-nano'])
    );

    mockRows[0].synced_at = '2026-04-29 00:16:12.945+00';
    await expect(getCachedOpenAiServedModels('partner-key')).resolves.toBeNull();

    mockRows[0].synced_at = '2026-04-29 01:16:12.945+00';
    mockRows[0].data = { data: [{ id: 123 }] };
    await expect(getCachedOpenAiServedModels('partner-key')).resolves.toBeNull();
    await expect(getCachedOpenRouterModels()).resolves.toBeNull();
    now.mockRestore();
  });

  it('serves a fresh validated OpenRouter catalog', async () => {
    mockRows.push({
      data: {
        data: Array.from({ length: 100 }, (_, index) => ({ ...catalogModel, id: `${index}` })),
      },
      synced_at: new Date().toISOString(),
    });

    const cached = await getCachedOpenRouterModels();
    expect(cached?.data).toHaveLength(100);
    await getCachedOpenRouterModels();
    expect(readDb.select).toHaveBeenCalledTimes(1);

    mockRows[0].synced_at = new Date(Date.now() - 16 * 60_000).toISOString();
    invalidateCachedOpenRouterModels();
    await expect(getCachedOpenRouterModels()).resolves.toBeNull();
  });
});
