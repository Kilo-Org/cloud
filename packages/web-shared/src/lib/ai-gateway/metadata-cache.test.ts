import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import {
  createCachedMetadataReader,
  fetchMetadata,
  getMetadata,
  readStoredMetadata,
  type MetadataSource,
} from './metadata-cache';

const ModelsSchema = z.object({ models: z.array(z.string()) });

const source: MetadataSource<z.infer<typeof ModelsSchema>> = {
  url: 'https://metadata.test/v1/models',
  headers: () => ({ authorization: 'Bearer test-key' }),
  parse: raw => ModelsSchema.parse(raw),
};

const NOT_FOUND_MARKER = { status: 404 };

const sourceWithNotFoundMarker: MetadataSource<z.infer<typeof ModelsSchema>> = {
  ...source,
  rawWhenNotFound: NOT_FOUND_MARKER,
  parse: raw =>
    z.strictObject({ status: z.literal(404) }).safeParse(raw).success
      ? { models: [] }
      : ModelsSchema.parse(raw),
};

let fetchSpy: jest.SpiedFunction<typeof fetch>;

function storeRow(data: unknown) {
  return db.insert(ai_gateway_metadata_cache).values({ url: source.url, data });
}

beforeEach(async () => {
  await db.delete(ai_gateway_metadata_cache).where(sql`true`);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ models: ['live'] }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('readStoredMetadata', () => {
  it('returns the parsed stored row', async () => {
    await storeRow({ models: ['stored'] });

    await expect(readStoredMetadata(source, db)).resolves.toEqual({ models: ['stored'] });
  });

  it('returns null when no row is stored', async () => {
    await expect(readStoredMetadata(source, db)).resolves.toBeNull();
  });

  it('returns null when the stored row no longer parses', async () => {
    await storeRow({ models: 'not-a-list' });

    await expect(readStoredMetadata(source, db)).resolves.toBeNull();
  });
});

describe('getMetadata', () => {
  it('uses the stored row without fetching', async () => {
    await storeRow({ models: ['stored'] });

    await expect(getMetadata(source, db)).resolves.toEqual({ models: ['stored'] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a stored not-found marker without fetching', async () => {
    await storeRow(NOT_FOUND_MARKER);

    await expect(getMetadata(sourceWithNotFoundMarker, db)).resolves.toEqual({ models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches when no row is stored', async () => {
    await expect(getMetadata(source, db)).resolves.toEqual({ models: ['live'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the given fallback when no row is stored', async () => {
    await expect(getMetadata(source, db, async () => ({ models: ['fallback'] }))).resolves.toEqual({
      models: ['fallback'],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fetchMetadata', () => {
  it('returns the raw body and its parsed form, bypassing the framework data cache', async () => {
    await expect(fetchMetadata(source)).resolves.toEqual({
      raw: { models: ['live'] },
      data: { models: ['live'] },
    });
    expect(fetchSpy).toHaveBeenCalledWith(source.url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer test-key' },
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a non-ok response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 503, statusText: 'Service Unavailable' })
    );

    await expect(fetchMetadata(source)).rejects.toThrow(
      `Fetching ${source.url} failed: 503 Service Unavailable`
    );
  });

  it('rejects a body that does not parse', async () => {
    fetchSpy.mockResolvedValue(Response.json({ models: 'not-a-list' }));

    await expect(fetchMetadata(source)).rejects.toThrow();
  });

  it('rejects a 404 when the source has no stand-in body', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));

    await expect(fetchMetadata(source)).rejects.toThrow(
      `Fetching ${source.url} failed: 404 Not Found`
    );
  });

  it('returns the stand-in body and its parsed form for a 404', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));

    await expect(fetchMetadata(sourceWithNotFoundMarker)).resolves.toEqual({
      raw: NOT_FOUND_MARKER,
      data: { models: [] },
    });
  });

  it('still rejects other error statuses when the source has a stand-in body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchMetadata(sourceWithNotFoundMarker)).rejects.toThrow(
      `Fetching ${source.url} failed: 500 Internal Server Error`
    );
  });
});

describe('createCachedMetadataReader', () => {
  it('reuses the value within the TTL and reloads after reset', async () => {
    const reader = createCachedMetadataReader(source, { fromDb: db, ttlMs: 60_000 });

    await expect(reader.get()).resolves.toEqual({ models: ['live'] });
    await storeRow({ models: ['stored'] });
    await expect(reader.get()).resolves.toEqual({ models: ['live'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    reader.reset();

    await expect(reader.get()).resolves.toEqual({ models: ['stored'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL has passed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const reader = createCachedMetadataReader(source, { fromDb: db, ttlMs: 60_000 });

    await reader.get();
    now.mockReturnValue(1_000_000 + 60_000);
    await reader.get();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws the load error when no load has ever succeeded', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    const reader = createCachedMetadataReader(source, { fromDb: db, ttlMs: 60_000 });

    await expect(reader.get()).rejects.toThrow(`Fetching ${source.url} failed: 500`);
  });
});
