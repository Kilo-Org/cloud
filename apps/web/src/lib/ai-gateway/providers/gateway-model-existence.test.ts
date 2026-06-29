import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import { redisClient } from '@/lib/redis';
import {
  gatewayModelExists,
  writeGatewayModelExistenceMarkers,
  routableLanguageModelIds,
  GATEWAY_MODEL_EXISTENCE_TTL_SECONDS,
} from './gateway-model-existence';

// NOTE: jest.mock must come after the imports above; with this repo's @swc/jest
// setup a mock declared before the imports is not applied.
type FakeRedis = {
  get: jest.Mock;
  set: (key: string, value: string, opts?: { ex?: number }) => void;
  pipeline: () => {
    set: (key: string, value: string, opts?: { ex?: number }) => unknown;
    exec: () => Promise<unknown[]>;
  };
  __store: Map<string, { value: string; expiresAt: number | null }>;
  __failNextGet: () => void;
};

jest.mock('@/lib/redis', () => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  let failNextGet = false;

  const set = (key: string, value: string, opts?: { ex?: number }) => {
    store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
  };

  const get = jest.fn(async (key: string) => {
    if (failNextGet) {
      failNextGet = false;
      throw new Error('redis unavailable');
    }
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  });

  return {
    redisClient: {
      get,
      set,
      pipeline: () => {
        const ops: Array<() => void> = [];
        const p = {
          set(key: string, value: string, opts?: { ex?: number }) {
            ops.push(() => set(key, value, opts));
            return p;
          },
          async exec() {
            for (const op of ops) op();
            return [];
          },
        };
        return p;
      },
      __store: store,
      __failNextGet: () => {
        failNextGet = true;
      },
    },
  };
});

const fakeRedis = redisClient as unknown as FakeRedis;

function model(id: string, overrides: Partial<StoredModel> = {}): StoredModel {
  return { id, name: id, type: 'language', endpoints: [{ provider_name: 'p' }], ...overrides };
}

beforeEach(() => {
  fakeRedis.__store.clear();
  fakeRedis.get.mockClear();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('routableLanguageModelIds', () => {
  it('keeps language models with endpoints and drops the rest', () => {
    const ids = routableLanguageModelIds({
      a: model('openai/gpt-4o'),
      b: model('img', { type: 'image' }),
      c: model('no-endpoints', { endpoints: [] }),
      d: model('default-type', { type: undefined }),
    });
    expect(ids.toSorted()).toEqual(['default-type', 'openai/gpt-4o']);
  });
});

describe('writeGatewayModelExistenceMarkers + gatewayModelExists', () => {
  it('marks routable models as existing and others as not', async () => {
    await writeGatewayModelExistenceMarkers('openrouter', {
      a: model('poolside/laguna-m.1:free'),
      b: model('embedded', { type: 'embedding' }),
    });

    expect(await gatewayModelExists('openrouter', 'poolside/laguna-m.1:free')).toBe(true);
    expect(await gatewayModelExists('openrouter', 'embedded')).toBe(false);
    expect(await gatewayModelExists('openrouter', 'never-synced')).toBe(false);
  });

  it('keeps openrouter and vercel namespaces separate', async () => {
    await writeGatewayModelExistenceMarkers('vercel', { a: model('anthropic/claude') });

    expect(await gatewayModelExists('vercel', 'anthropic/claude')).toBe(true);
    expect(await gatewayModelExists('openrouter', 'anthropic/claude')).toBe(false);
  });

  it('expires markers after the TTL when sync stops refreshing them', async () => {
    await writeGatewayModelExistenceMarkers('openrouter', { a: model('stale/model') });
    expect(await gatewayModelExists('openrouter', 'stale/model')).toBe(true);

    jest.advanceTimersByTime((GATEWAY_MODEL_EXISTENCE_TTL_SECONDS + 1) * 1000);

    expect(await gatewayModelExists('openrouter', 'stale/model')).toBe(false);
  });

  it('does not write anything when there are no routable models', async () => {
    await writeGatewayModelExistenceMarkers('openrouter', { a: model('img', { type: 'image' }) });
    expect(fakeRedis.__store.size).toBe(0);
  });
});

describe('gatewayModelExists in-process cache', () => {
  it('serves repeated lookups of the same model without re-reading Redis', async () => {
    await gatewayModelExists('vercel', 'cached/model');
    await gatewayModelExists('vercel', 'cached/model');
    await gatewayModelExists('vercel', 'cached/model');
    expect(fakeRedis.get).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry once the cache cap is exceeded', async () => {
    await gatewayModelExists('vercel', 'first/model');
    expect(fakeRedis.get).toHaveBeenCalledTimes(1);

    // Fill the cache past its cap with distinct ids, evicting 'first/model'.
    for (let i = 0; i <= 2_000; i++) {
      await gatewayModelExists('vercel', `filler/${i}`);
    }

    fakeRedis.get.mockClear();
    await gatewayModelExists('vercel', 'first/model');
    expect(fakeRedis.get).toHaveBeenCalledTimes(1);
  });
});

describe('gatewayModelExists fail-open behavior', () => {
  it('returns false on a cold Redis failure', async () => {
    fakeRedis.__failNextGet();
    expect(await gatewayModelExists('openrouter', 'cold/failure')).toBe(false);
  });

  it('returns the last-known value on a later Redis failure', async () => {
    await writeGatewayModelExistenceMarkers('openrouter', { a: model('warm/model') });
    expect(await gatewayModelExists('openrouter', 'warm/model')).toBe(true);

    // Advance past the in-process cache window (but within the marker TTL) so the
    // next call reaches Redis, then make that read fail.
    jest.advanceTimersByTime(120_000);
    fakeRedis.__failNextGet();

    expect(await gatewayModelExists('openrouter', 'warm/model')).toBe(true);
  });
});
