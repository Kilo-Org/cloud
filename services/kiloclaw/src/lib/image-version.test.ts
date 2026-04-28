import { describe, it, expect, beforeEach } from 'vitest';
import { suppressConsole } from '../test-utils';
import { resolveLatestVersion, registerVersionIfNeeded } from './image-version';
import { imageVersionKey, imageVersionLatestKey } from '../schemas/image-version';
import type { ImageVersionEntry } from '../schemas/image-version';

/** KV mock that handles the 'json' type parameter like the real KV API. */
function createJsonKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    get: (key: string, type?: string) => {
      const val = store.get(key) ?? null;
      if (val === null) return Promise.resolve(null);
      if (type === 'json') return Promise.resolve(JSON.parse(val));
      return Promise.resolve(val);
    },
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: () => Promise.resolve({ value: null, metadata: null, cacheStatus: null }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function makeEntry(overrides: Partial<ImageVersionEntry> = {}): ImageVersionEntry {
  return {
    openclawVersion: '2026.2.9',
    variant: 'default',
    imageTag: 'dev-123456',
    imageDigest: null,
    publishedAt: '2026-02-22T18:00:00Z',
    rolloutPercent: 0,
    isLatest: false,
    ...overrides,
  };
}

describe('resolveLatestVersion', () => {
  beforeEach(() => suppressConsole());

  it('returns the full entry when latest is populated', async () => {
    const kv = createJsonKV();
    const entry = makeEntry();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry));

    const result = await resolveLatestVersion(kv, 'default');
    expect(result).toEqual(entry);
  });

  it('returns null when KV is empty', async () => {
    const kv = createJsonKV();
    const result = await resolveLatestVersion(kv, 'default');
    expect(result).toBeNull();
  });

  it('returns null for invalid KV data', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify({ bad: 'data' }));

    const result = await resolveLatestVersion(kv, 'default');
    expect(result).toBeNull();
  });
});

describe('registerVersionIfNeeded', () => {
  beforeEach(() => suppressConsole());

  it('writes versioned key + per-tag key, but NOT :latest (markImageAsLatest owns that)', async () => {
    const kv = createJsonKV();

    const result = await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-123');
    expect(result).toBe(true);

    const versioned = kv._store.get(imageVersionKey('2026.2.9', 'default'));
    const tagged = kv._store.get('image-version-tag:dev-123');
    const latest = kv._store.get(imageVersionLatestKey('default'));

    expect(versioned).toBeDefined();
    expect(tagged).toBeDefined();
    // Latest is NOT auto-written anymore — it's owned by markImageAsLatest.
    expect(latest).toBeUndefined();

    const parsed = JSON.parse(tagged!) as Record<string, unknown>;
    expect(parsed.openclawVersion).toBe('2026.2.9');
    expect(parsed.imageTag).toBe('dev-123');
    expect(parsed.imageDigest).toBeNull();
    expect(parsed.rolloutPercent).toBe(0);
    expect(parsed.isLatest).toBe(false);
  });

  it('no-ops when the per-tag entry already exists', async () => {
    const kv = createJsonKV();
    await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-123');
    const result = await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-123');
    expect(result).toBe(false);
  });

  it('writes a new entry when the tag is different (rebuild of same openclaw version)', async () => {
    const kv = createJsonKV();

    await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-123');
    const result = await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-456');
    expect(result).toBe(true);

    const taggedNew = JSON.parse(kv._store.get('image-version-tag:dev-456')!) as Record<
      string,
      unknown
    >;
    expect(taggedNew.imageTag).toBe('dev-456');
    expect(taggedNew.rolloutPercent).toBe(0);
  });

  it('stores imageDigest when provided', async () => {
    const kv = createJsonKV();

    await registerVersionIfNeeded(kv, '2026.2.9', 'default', 'dev-123', 'sha256:abc');

    const tagged = JSON.parse(kv._store.get('image-version-tag:dev-123')!) as Record<
      string,
      unknown
    >;
    expect(tagged.imageDigest).toBe('sha256:abc');
  });
});
