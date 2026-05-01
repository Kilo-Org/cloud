import { describe, it, expect } from 'vitest';
import { selectImageVersionForInstance, imageVersionCandidateKey } from './version-rollout';
import { imageVersionLatestKey } from '../schemas/image-version';
import type { ImageVersionEntry } from '../schemas/image-version';

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

function entry(imageTag: string, rolloutPercent: number, isLatest = false): ImageVersionEntry {
  return {
    openclawVersion: '2026.4.15',
    variant: 'default',
    imageTag,
    imageDigest: null,
    publishedAt: '2026-04-27T00:00:00Z',
    rolloutPercent,
    isLatest,
  };
}

describe('selectImageVersionForInstance', () => {
  it('returns null when no pointers exist (e.g. fresh deploy)', async () => {
    const kv = createJsonKV();
    const result = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-1',
    });
    expect(result).toBeNull();
  });

  it('returns :latest when no candidate is set and instance is on something older', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));

    const result = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-1',
      currentImageTag: 'img-old',
    });
    expect(result?.imageTag).toBe('img-stable');
  });

  it('returns null when instance is already on :latest and there is no candidate', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));

    const result = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-1',
      currentImageTag: 'img-stable',
    });
    expect(result).toBeNull();
  });

  it('offers candidate to in-cohort instances and falls back to :latest for out-of-cohort', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 50)));

    let inCohort = 0;
    let outOfCohort = 0;
    for (let i = 0; i < 200; i++) {
      const result = await selectImageVersionForInstance({
        kv,
        variant: 'default',
        instanceId: `synthetic-${i}`,
        currentImageTag: 'img-old',
      });
      if (result?.imageTag === 'img-candidate') inCohort++;
      else if (result?.imageTag === 'img-stable') outOfCohort++;
    }
    // 50% cohort, ±10pp tolerance for sample size.
    expect(inCohort).toBeGreaterThan(80);
    expect(inCohort).toBeLessThan(120);
    expect(outOfCohort).toBe(200 - inCohort);
  });

  it('autoEnroll bypasses the bucket and always returns the candidate', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    // 1% rollout — almost no random instance will qualify
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 1)));

    for (let i = 0; i < 50; i++) {
      const result = await selectImageVersionForInstance({
        kv,
        variant: 'default',
        instanceId: `synthetic-${i}`,
        currentImageTag: 'img-old',
        autoEnroll: true,
      });
      expect(result?.imageTag).toBe('img-candidate');
    }
  });

  it('returns null (no upgrade) when instance is already on the active candidate', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 100)));

    const result = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-1',
      currentImageTag: 'img-candidate',
    });
    // Critical: must NOT fall through to :latest — that would downgrade an
    // instance that's already running the staged candidate. Sticky-on-candidate
    // is the documented behavior; admin must explicitly disable the tag to
    // displace.
    expect(result).toBeNull();
  });

  it('returns :latest when no candidate is in flight and instance is on something older', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    // No candidate pointer set.

    const result = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-1',
      currentImageTag: 'img-old',
    });
    expect(result?.imageTag).toBe('img-stable');
  });

  it('treats percent=0 candidate as not-rolled-out (no one qualifies)', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 0)));

    for (let i = 0; i < 50; i++) {
      const result = await selectImageVersionForInstance({
        kv,
        variant: 'default',
        instanceId: `synthetic-${i}`,
        currentImageTag: 'img-old',
      });
      // Always falls through to :latest, never picks the 0% candidate.
      expect(result?.imageTag).toBe('img-stable');
    }
  });

  it('treats percent=100 candidate as fully rolled out (everyone qualifies)', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 100)));

    for (let i = 0; i < 50; i++) {
      const result = await selectImageVersionForInstance({
        kv,
        variant: 'default',
        instanceId: `synthetic-${i}`,
        currentImageTag: 'img-old',
      });
      expect(result?.imageTag).toBe('img-candidate');
    }
  });

  it('is deterministic for the same instance and same candidate', async () => {
    const kv = createJsonKV();
    await kv.put(imageVersionLatestKey('default'), JSON.stringify(entry('img-stable', 0, true)));
    await kv.put(imageVersionCandidateKey('default'), JSON.stringify(entry('img-candidate', 50)));

    const first = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-stable',
      currentImageTag: 'img-old',
    });
    const second = await selectImageVersionForInstance({
      kv,
      variant: 'default',
      instanceId: 'instance-stable',
      currentImageTag: 'img-old',
    });
    expect(first?.imageTag).toBe(second?.imageTag);
  });
});
