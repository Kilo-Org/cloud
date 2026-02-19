/**
 * Configuration constants for KiloClaw
 */

/** Port that the OpenClaw gateway listens on inside the Fly Machine */
export const OPENCLAW_PORT = 18789;

/** Maximum time to wait for the machine to reach 'started' state.
 *  Fly's /wait endpoint caps at 60s (spec.json:1538). */
export const STARTUP_TIMEOUT_SECONDS = 60;

/** Cookie name for worker auth token (set by worker after access code redemption) */
export const KILOCLAW_AUTH_COOKIE = 'kiloclaw-auth';

/** Cookie max age: 24 hours */
export const KILOCLAW_AUTH_COOKIE_MAX_AGE = 60 * 60 * 24;

/** Expected JWT token version -- must match cloud's JWT_TOKEN_VERSION */
export const KILO_TOKEN_VERSION = 3;

/** Default Fly Machine guest spec (shared-cpu-2x, 4GB) */
export const DEFAULT_MACHINE_GUEST = {
  cpus: 2,
  memory_mb: 4096,
  cpu_kind: 'shared' as const,
};

/** Default Fly Volume size in GB */
export const DEFAULT_VOLUME_SIZE_GB = 10;

// Alarm cadence by instance status
/** Running machines: fast health checks */
export const ALARM_INTERVAL_RUNNING_MS = 5 * 60 * 1000; // 5 min
/** Destroying: retry pending deletes quickly */
export const ALARM_INTERVAL_DESTROYING_MS = 60 * 1000; // 1 min
/** Provisioned/stopped: slow drift detection */
export const ALARM_INTERVAL_IDLE_MS = 30 * 60 * 1000; // 30 min
/** Random jitter added to alarm scheduling to prevent Fly API bursts */
export const ALARM_JITTER_MS = 60 * 1000; // 0-60s

/** Consecutive failed health checks before marking a running instance as stopped */
export const SELF_HEAL_THRESHOLD = 5;

/** Minimum interval between live Fly API checks in getStatus() (30 seconds).
 *  At 10s UI poll interval, only ~1 in 3 polls will hit Fly. */
export const LIVE_CHECK_THROTTLE_MS = 30 * 1000;
