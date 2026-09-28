import { vi } from 'vitest';

// These integration tests wait on state produced by cross-Durable-Object RPC
// and WebSocket round-trips inside workerd. The suite runs its files in
// parallel, so a healthy poll can take longer than vitest's 1 s `vi.waitFor`
// default and fail a correct run. Poll with the same semantics and a budget
// that reflects the runtime; a genuinely stuck wait still fails, just after
// this budget instead of after one second.
export const INTEGRATION_WAIT_TIMEOUT_MS = 10_000;

export function waitFor<T>(
  callback: () => T | Promise<T>,
  options?: { interval?: number; timeout?: number }
): Promise<T> {
  return vi.waitFor(callback, {
    interval: 50,
    timeout: INTEGRATION_WAIT_TIMEOUT_MS,
    ...options,
  });
}
