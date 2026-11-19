import { runtimeAuthorizationMaximumLifetimeMs } from '@kilocode/worker-utils/runtime-authorization-contract';

export const RUNTIME_AUTHORIZATION_LIFETIME_OVERRIDE_ENV = 'RUNTIME_AUTHORIZATION_LIFETIME_MS';

const MINIMUM_OVERRIDE_MS = 60_000;

/**
 * A shorter runtime delegation for local expiry tests. Development-only by
 * absence from production config, like `CONTROL_PLANE_TIMER_DIVISOR`; do not add
 * it to wrangler.jsonc. Production always keeps the resource maximum.
 */
export function runtimeAuthorizationLifetime(env: {
  ENVIRONMENT?: string;
}): { lifetimeMs: number } | Record<string, never> {
  if (env.ENVIRONMENT !== 'development') return {};
  const raw = (env as Record<string, unknown>)[RUNTIME_AUTHORIZATION_LIFETIME_OVERRIDE_ENV];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return {};
  const lifetimeMs = Number(raw);
  return lifetimeMs >= MINIMUM_OVERRIDE_MS &&
    lifetimeMs <= runtimeAuthorizationMaximumLifetimeMs('cloud-agent-next')
    ? { lifetimeMs }
    : {};
}
