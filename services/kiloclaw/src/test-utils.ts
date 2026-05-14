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
    KILOCLAW_REGISTRY: {} as unknown as KiloClawEnv['KILOCLAW_REGISTRY'],
    KILOCLAW_CONTROLLER_AE: {
      writeDataPoint: vi.fn(),
    } as unknown as KiloClawEnv['KILOCLAW_CONTROLLER_AE'],
    HYPERDRIVE: {} as unknown as KiloClawEnv['HYPERDRIVE'],
    KV_CLAW_CACHE: createMockKV(),
    // Per-instance virtual-hosting config defaults. Tests that want to
    // exercise the "missing config" path should explicitly set these to
    // undefined via the overrides.
    KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
    KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
