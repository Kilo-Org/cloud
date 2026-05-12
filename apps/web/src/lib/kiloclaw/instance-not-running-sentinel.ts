/**
 * Shared shape returned by KiloClaw polling endpoints when the Durable
 * Object state isn't `running`. The worker short-circuits before forwarding
 * to the Fly proxy (which would otherwise wake a stopped machine).
 *
 * Returned at HTTP 200 (not 503) so high-frequency polling doesn't generate
 * log/Sentry noise for an expected steady state. Mirrors the
 * `/gateway/ready` precedent in services/kiloclaw/src/routes/platform.ts.
 *
 * This module intentionally has zero external dependencies so it can be
 * imported from any app (web, mobile) via the same path. Mobile aliases
 * this file into `@/lib/kiloclaw/instance-not-running-sentinel` via its
 * tsconfig paths.
 */

export type InstanceNotRunningSentinel = {
  ok: false;
  reason: 'instance_not_running';
  /** Current DO status. Frontend can use this to render a richer label
   *  (e.g. "Instance is starting…" vs "Instance is stopped"). */
  status:
    | 'provisioned'
    | 'starting'
    | 'restarting'
    | 'recovering'
    | 'stopped'
    | 'destroying'
    | 'restoring'
    | null;
};

export function isInstanceNotRunningSentinel(value: unknown): value is InstanceNotRunningSentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    (value as { reason?: unknown }).reason === 'instance_not_running'
  );
}
