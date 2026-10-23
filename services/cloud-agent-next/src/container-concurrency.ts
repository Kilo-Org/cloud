import type { Env } from './types.js';

export class ContainerCapacityUnavailableError extends Error {
  readonly code = 'container_capacity_unavailable';

  constructor() {
    super(
      'container_capacity_unavailable: Cannot verify container capacity or account balance. Try again shortly.'
    );
    this.name = 'ContainerCapacityUnavailableError';
  }
}

/** Recognizes admission failures even after Durable Object RPC flattens them. */
export function getContainerCapacityFailureReason(
  error: unknown
): 'container_limit_reached' | 'billing_unavailable' | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'container_limit_reached') return 'container_limit_reached';
    if (error.code === 'container_capacity_unavailable') return 'billing_unavailable';
  }
  const message =
    typeof error === 'string'
      ? error
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : '';
  if (message.includes('container_limit_reached:')) return 'container_limit_reached';
  if (message.includes('container_capacity_unavailable:')) return 'billing_unavailable';
  return undefined;
}

/**
 * The usage meter applies the concurrent-container cap when a start that has
 * not launched opens its interval. The E2E suite runs every scenario through
 * one funded test account, so it turns the cap off. Production leaves the flag
 * unset.
 */
export function containerCapacityEnforced(
  env: Pick<Env, 'CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED'>
): boolean {
  return env.CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED !== 'true';
}
