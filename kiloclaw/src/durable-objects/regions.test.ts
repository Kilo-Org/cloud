import { describe, it, expect } from 'vitest';
import { removeRegionFromKv } from './regions';

/**
 * Minimal KVNamespace stub: stores one key in memory.
 */
function makeKv(initial?: string): { kv: KVNamespace; stored: () => string | null } {
  let stored: string | null = initial ?? null;
  const kv = {
    async get(_key: string) {
      return stored;
    },
    async put(_key: string, value: string) {
      stored = value;
    },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: stored, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
  return { kv, stored: () => stored };
}

/**
 * KVNamespace stub that always throws on get and put (simulates a KV outage).
 */
function makeFailingKv(): KVNamespace {
  return {
    async get() {
      throw new Error('KV unavailable');
    },
    async put() {
      throw new Error('KV unavailable');
    },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe('removeRegionFromKv', () => {
  describe('no-op cases', () => {
    it('skips when KV holds only meta-regions', async () => {
      const { kv, stored } = makeKv('eu,us');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('skipped_meta');
      expect(stored()).toBe('eu,us'); // unchanged
    });

    it('skips when KV holds a single meta-region', async () => {
      const { kv } = makeKv('eu');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('skipped_meta');
    });

    it('skips when env fallback holds only meta-regions and KV is empty', async () => {
      const { kv } = makeKv(); // no KV value
      const result = await removeRegionFromKv(kv, 'us,eu', 'lax');
      expect(result.action).toBe('skipped_meta');
    });

    it('returns not_in_list when failed region is not present', async () => {
      const { kv, stored } = makeKv('iad,lax,ewr');
      const result = await removeRegionFromKv(kv, undefined, 'ord');
      expect(result.action).toBe('not_in_list');
      expect(stored()).toBe('iad,lax,ewr'); // unchanged
    });
  });

  describe('removal cases', () => {
    it('removes a failed region when 3+ named regions remain', async () => {
      const { kv, stored } = makeKv('iad,lax,ewr,ord');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('removed');
      if (result.action === 'removed') {
        expect(result.removedRegion).toBe('iad');
        expect(result.newRegions).toEqual(['lax', 'ewr', 'ord']);
        expect(result.newRaw).toBe('lax,ewr,ord');
      }
      expect(stored()).toBe('lax,ewr,ord');
    });

    it('removes a failed region that appears as duplicate', async () => {
      // duplicates are legal (they bias shuffle probability)
      const { kv, stored } = makeKv('iad,iad,lax,ewr');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('removed');
      if (result.action === 'removed') {
        expect(result.newRegions).toEqual(['lax', 'ewr']);
      }
      expect(stored()).toBe('lax,ewr');
    });

    it('removes a region from a 3-region list leaving 2', async () => {
      const { kv, stored } = makeKv('iad,lax,ewr');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('removed');
      if (result.action === 'removed') {
        expect(result.newRaw).toBe('lax,ewr');
      }
      expect(stored()).toBe('lax,ewr');
    });
  });

  describe('revert-to-meta cases', () => {
    it('reverts to meta when removing would leave only 1 named region', async () => {
      const { kv, stored } = makeKv('iad,lax');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('reverted_to_meta');
      if (result.action === 'reverted_to_meta') {
        expect(result.removedRegion).toBe('iad');
        // Last remaining named region is prefixed as breadcrumb
        expect(result.newRaw).toBe('lax,eu,us');
      }
      expect(stored()).toBe('lax,eu,us');
    });

    it('reverts to meta when last region appears as duplicates', async () => {
      // 'lax,lax' has only 1 distinct region — removing 'iad' leaves only 'lax'
      const { kv } = makeKv('iad,lax,lax');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('reverted_to_meta');
      if (result.action === 'reverted_to_meta') {
        expect(result.newRaw).toBe('lax,eu,us');
      }
    });

    it('reverts to bare meta when no named region would remain after removal', async () => {
      // Edge: list has a mix of meta+named, removing the only named region
      const { kv, stored } = makeKv('iad,eu');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('reverted_to_meta');
      if (result.action === 'reverted_to_meta') {
        // No named region remains — just bare meta fallback
        expect(result.newRaw).toBe('eu,us');
      }
      expect(stored()).toBe('eu,us');
    });

    it('reverts to meta when only one named region is in the list', async () => {
      const { kv } = makeKv('iad');
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('reverted_to_meta');
      if (result.action === 'reverted_to_meta') {
        expect(result.newRaw).toBe('eu,us');
      }
    });
  });

  describe('fallback sources', () => {
    it('uses env fallback when KV is empty', async () => {
      const { kv, stored } = makeKv(); // empty KV
      const result = await removeRegionFromKv(kv, 'iad,lax,ewr', 'iad');
      expect(result.action).toBe('removed');
      // KV is now written even though it was previously empty
      expect(stored()).toBe('lax,ewr');
    });

    it('uses hardcoded default (eu,us) when both KV and env are empty', async () => {
      const { kv } = makeKv();
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      // Default is meta-only — no-op
      expect(result.action).toBe('skipped_meta');
    });
  });

  describe('KV failure tolerance', () => {
    it('returns skipped_meta when KV read fails and env fallback has meta-regions', async () => {
      const result = await removeRegionFromKv(makeFailingKv(), 'eu,us', 'iad');
      expect(result.action).toBe('skipped_meta');
    });

    it('still returns result when KV write fails after successful read', async () => {
      // KV with readable get but failing put
      const stored: string | null = 'iad,lax,ewr';
      const kv = {
        async get(_key: string) {
          return stored;
        },
        async put(_key: string, _value: string) {
          throw new Error('put failed');
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({
          value: stored,
          metadata: null,
          cacheStatus: null,
        }),
      } as unknown as KVNamespace;

      // put failure is swallowed; result is still meaningful
      const result = await removeRegionFromKv(kv, undefined, 'iad');
      expect(result.action).toBe('removed');
      // stored is unchanged because put threw
      expect(stored).toBe('iad,lax,ewr');
    });
  });
});
