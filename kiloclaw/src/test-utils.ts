/**
 * Shared test utilities for mocking environment
 */
import { vi } from 'vitest';
import type { KiloClawEnv } from './types';

/**
 * Create a minimal KiloClawEnv object for testing
 */
export function createMockEnv(overrides: Partial<KiloClawEnv> = {}): KiloClawEnv {
  return {
    KILOCLAW_INSTANCE: {} as unknown as KiloClawEnv['KILOCLAW_INSTANCE'],
    KILOCLAW_APP: {} as unknown as KiloClawEnv['KILOCLAW_APP'],
    HYPERDRIVE: {} as unknown as KiloClawEnv['HYPERDRIVE'],
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
