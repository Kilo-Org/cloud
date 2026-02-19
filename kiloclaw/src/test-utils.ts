/**
 * Shared test utilities for mocking environment
 */
import { vi } from 'vitest';
import type { KiloClawEnv } from './types';

/**
 * Create a minimal KiloClawEnv object for testing
 */
/** Minimal in-memory KV stub for tests. */
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
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
  } as unknown as KVNamespace;
}

export function createMockEnv(overrides: Partial<KiloClawEnv> = {}): KiloClawEnv {
  return {
    KILOCLAW_INSTANCE: {} as unknown as KiloClawEnv['KILOCLAW_INSTANCE'],
    KILOCLAW_APP: {} as unknown as KiloClawEnv['KILOCLAW_APP'],
    HYPERDRIVE: {} as unknown as KiloClawEnv['HYPERDRIVE'],
    KV_CLAW_CACHE: createMockKV(),
    ...overrides,
  };
}

/**
 * Suppress console output during tests
 */
export function suppressConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}
