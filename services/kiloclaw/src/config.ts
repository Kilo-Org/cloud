export { KILO_TOKEN_VERSION } from '@kilocode/worker-utils';

/**
 * Configuration constants for KiloClaw
 */

/** Port that the OpenClaw gateway listens on inside the Fly Machine */
export const OPENCLAW_PORT = 18789;

/** Internal loopback port for the OpenClaw gateway process (behind controller) */
export const OPENCLAW_INTERNAL_PORT = 3001;

/** OpenClaw's built-in default model when using the kilocode provider.
 *  Used as fallback when the user clears their model selection. */
export const OPENCLAW_BUILTIN_DEFAULT_MODEL = 'kilocode/anthropic/claude-opus-4.6';

/**
 * Version marker for what the worker hands to a machine's controller at
 * provision/start/restart time. Bumped when we change the set of env vars,
 * controller config shape, or origin-check rules. Persisted per-instance as
 * `controllerCapabilitiesVersion` so callers can tell which controller
 * configuration contract a running machine was started with.
 *
 * Legacy instances (persisted as null) are treated as version 1.
 *
 * Version history:
 *   1 — implicit; pre-capability-tracking.
 *   2 — controller env contains a per-instance literal origin
 *       `https://<label>.kiloclaw.ai` appended to OPENCLAW_ALLOWED_ORIGINS.
 *       Origin checking remains exact string only; wildcard host patterns are
 *       not supported.
 */
export const WORKER_CONTROLLER_CAPABILITIES_VERSION = 2;

/** Maximum time to wait for the machine to reach 'started' state.
 *  Fly's /wait endpoint caps at 60s (spec.json:1538). */
export const STARTUP_TIMEOUT_SECONDS = 60;

/** Cookie name for worker auth token (set by worker after access code redemption) */
export const KILOCLAW_AUTH_COOKIE = 'kiloclaw-auth';

/**
 * Cookie that tracks which instance the user is currently accessing.
 * Set by the access gateway when opening an instance-keyed instance.
 * Read by the catch-all proxy to route WebSocket/HTTP traffic to the
 * correct instance (the OpenClaw Control UI connects to `/` without
 * the `/i/{instanceId}/` prefix).
 */
export const KILOCLAW_ACTIVE_INSTANCE_COOKIE = 'kiloclaw-active-instance';

/** Cookie max age: 24 hours */
export const KILOCLAW_AUTH_COOKIE_MAX_AGE = 60 * 60 * 24;

/** API key max age for gateway credentials minted by the worker */
export const KILOCODE_API_KEY_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/** Default Fly Machine guest spec (performance-1x, 3GB) */
export const DEFAULT_MACHINE_GUEST = {
  cpus: 1,
  memory_mb: 3072,
  cpu_kind: 'performance' as const,
};

/** Default Fly Volume size in GB */
export const DEFAULT_VOLUME_SIZE_GB = 10;

/** Default Fly region priority list when FLY_REGION env var is not set. */
export const DEFAULT_FLY_REGION = 'eu,us';

// Alarm cadence by instance status
/** Running machines: fast health checks */
export const ALARM_INTERVAL_RUNNING_MS = 5 * 60 * 1000; // 5 min
/** Starting: wait for start() to complete and reconcile quickly */
export const ALARM_INTERVAL_STARTING_MS = 60 * 1000; // 1 min
/** Restarting: wait for restartMachine() background work and reconcile quickly */
export const ALARM_INTERVAL_RESTARTING_MS = 60 * 1000; // 1 min
/** Recovering: relocate onto a new volume/host and reconcile quickly */
export const ALARM_INTERVAL_RECOVERING_MS = 60 * 1000; // 1 min
/** Maximum time to stay in 'starting' before falling back to 'stopped' */
export const STARTING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
/** Maximum time to stay in 'restarting' before surfacing a timeout */
export const RESTARTING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
/** Hard ceiling for 'restarting' — transient Fly states like 'replacing' (image
 *  pull) can legitimately take 10+ min. After this, give up and transition to
 *  'stopped' regardless of Fly state. */
export const RESTARTING_MAX_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
/** Maximum time to stay in 'recovering' before surfacing a timeout */
export const RECOVERING_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
/** Destroying: retry pending deletes quickly */
export const ALARM_INTERVAL_DESTROYING_MS = 60 * 1000; // 1 min
/** Provisioned/stopped: slow drift detection */
export const ALARM_INTERVAL_IDLE_MS = 30 * 60 * 1000; // 30 min
/** Random jitter added to alarm scheduling to prevent Fly API bursts */
export const ALARM_JITTER_MS = 60 * 1000; // 0-60s

/** Consecutive Fly `stopped` confirmations before triggering unexpected-stop recovery */
export const SELF_HEAL_THRESHOLD = 1;

/** Retain a replaced volume for rollback/debug only when snapshots exist. */
export const PREVIOUS_VOLUME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum interval between live Fly API checks in getStatus() (30 seconds).
 *  At 10s UI poll interval, only ~1 in 3 polls will hit Fly. */
export const LIVE_CHECK_THROTTLE_MS = 30 * 1000;

/** Maximum time to wait for the gateway health probe to return 200 after machine starts */
export const HEALTH_PROBE_TIMEOUT_SECONDS = 60;

/** Interval between health probe retries during startup */
export const HEALTH_PROBE_INTERVAL_MS = 3_000;

/** Auto-destroy provisioned instances that never started after this duration */
export const STALE_PROVISION_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Proactive API key refresh: default trigger when key expires within this window. */
export const PROACTIVE_REFRESH_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Read the proactive refresh threshold from an env override, falling back to
 * the hardcoded default. The env var is in hours for ease of use in wrangler vars.
 */
export function getProactiveRefreshThresholdMs(envOverrideHours?: string): number {
  if (envOverrideHours) {
    const hours = Number(envOverrideHours);
    if (!Number.isNaN(hours) && hours > 0) {
      return hours * 60 * 60 * 1000;
    }
  }
  return PROACTIVE_REFRESH_THRESHOLD_MS;
}
