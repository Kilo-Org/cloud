import type { UtsEnvironment } from '@kilocode/uts-contracts';
import type { Env, UtsConfig } from '../env';
import { type ManagerConfig, managerConfig } from '../manager/config';

/**
 * The identity-store login rotation (design 5.2). Each pool is one Hyperdrive config with two
 * logins; the job rotates the login that the config does not use, then switches the config to it.
 */
export const ROTATION_POOLS = ['app', 'pat', 'reader'] as const;
export type RotationPool = (typeof ROTATION_POOLS)[number];

export const LOGIN_NAMES = [
  'uts_app_a',
  'uts_app_b',
  'uts_pat_a',
  'uts_pat_b',
  'uts_reader_a',
  'uts_reader_b',
] as const;
export type LoginName = (typeof LOGIN_NAMES)[number];

export const POOL_LOGINS: Readonly<Record<RotationPool, readonly [LoginName, LoginName]>> = {
  app: ['uts_app_a', 'uts_app_b'],
  pat: ['uts_pat_a', 'uts_pat_b'],
  reader: ['uts_reader_a', 'uts_reader_b'],
};

/** The Cloudflare account that holds the Worker and its Hyperdrive configs (wrangler.jsonc). */
export const CLOUDFLARE_ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';

const CLOUDFLARE_API = 'https://api.cloudflare.com';

/**
 * The Hyperdrive config of each pool, as wrangler.jsonc binds them (`IDENTITY_STORE`,
 * `IDENTITY_STORE_PAT`, `IDENTITY_STORE_REPLICA`); test/repo checks that the two agree.
 * Development names the ids of wrangler.dev.jsonc, which only a local stand-in API knows.
 */
export const HYPERDRIVE_CONFIG_IDS: Readonly<
  Record<UtsEnvironment, Readonly<Record<RotationPool, string>>>
> = {
  production: {
    app: '314ea5eee7314e09b59728ff5453e9d9',
    pat: 'f041609cd77043d7b81bdd9265f46cec',
    reader: '4194e3ece2b442e381ec6d82f9bc0dcf',
  },
  staging: {
    app: '5dd523ea0fa447ebaf442a0300d8f848',
    pat: '48227f1c669742618bb7bc6adf9a416c',
    reader: '5fa4d303a52e4274a9750b20e2f507f0',
  },
  development: {
    app: 'uts-local-identity-store',
    pat: 'uts-local-identity-store-pat',
    reader: 'uts-local-identity-store-replica',
  },
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Every interval the job waits on. */
export type RotationTiming = {
  /** A pool rotates again this long after its last switch (design 4.5: 30 days). */
  periodMs: number;
  /** Two config switches stay at least this far apart (design 5.2: 5 minutes). */
  switchSpacingMs: number;
  /** The fallback `describeSecret` check while an approval waits (design 5.2: hourly). */
  approvalCheckMs: number;
  /** An approval that waits this long raises an alert (design 5.2: 24 hours). */
  approvalAlertMs: number;
  /** The wait after a retryable failure: a timeout, a 5xx, a lost connection. */
  retryMs: number;
  /** The wait after a refusal, which needs a configuration fix: it logs an error each time. */
  refusedRetryMs: number;
  /** Config switches run only inside this UTC hour range, `[start, end)`; null runs at any hour. */
  offPeakUtcHours: { start: number; end: number } | null;
};

export const DEPLOYED_TIMING: RotationTiming = {
  periodMs: 30 * DAY_MS,
  switchSpacingMs: 5 * MINUTE_MS,
  approvalCheckMs: HOUR_MS,
  approvalAlertMs: DAY_MS,
  retryMs: MINUTE_MS,
  refusedRetryMs: HOUR_MS,
  offPeakUtcHours: { start: 2, end: 5 },
};

/**
 * Development shortens every wait to at most the period that `LOGIN_ROTATION_PERIOD_SECONDS`
 * names, so the local end-to-end run can rotate twice in a minute; it has no off-peak window.
 */
export function developmentTiming(periodMs: number): RotationTiming {
  return {
    periodMs,
    switchSpacingMs: Math.min(DEPLOYED_TIMING.switchSpacingMs, periodMs),
    approvalCheckMs: Math.min(DEPLOYED_TIMING.approvalCheckMs, periodMs),
    approvalAlertMs: Math.min(DEPLOYED_TIMING.approvalAlertMs, periodMs * 24),
    retryMs: Math.min(DEPLOYED_TIMING.retryMs, periodMs),
    refusedRetryMs: Math.min(DEPLOYED_TIMING.refusedRetryMs, periodMs),
    offPeakUtcHours: null,
  };
}

export type RotationSettings =
  /** `LOGIN_ROTATION` is not `on`: the cron does not touch the job. */
  | { status: 'off' }
  /** On, but a binding or the manager is missing: the cron logs it and does nothing else. */
  | { status: 'misconfigured'; missing: readonly string[] }
  | {
      status: 'on';
      timing: RotationTiming;
      manager: ManagerConfig;
      cloudflare: {
        baseUrl: string;
        accountId: string;
        configIds: Readonly<Record<RotationPool, string>>;
      };
    };

/**
 * The per-environment switch. The job runs only where `LOGIN_ROTATION` is `on`; every deployed
 * block of wrangler.jsonc sets it to `off`, so a deploy changes nothing until an operator turns it
 * on for one environment.
 */
export function rotationSettings(env: Env, config: UtsConfig): RotationSettings {
  if (config.loginRotation.status === 'off') return { status: 'off' };
  const missing: string[] = [];
  if (env.IDENTITY_STORE === undefined) missing.push('IDENTITY_STORE');
  if (env.IDENTITY_STORE_PAT === undefined) missing.push('IDENTITY_STORE_PAT');
  if (env.IDENTITY_STORE_REPLICA === undefined) missing.push('IDENTITY_STORE_REPLICA');
  const manager = managerConfig(config);
  if (manager === null) missing.push('MANAGER_BASE_URL');
  const development = config.environment === 'development';
  if (development ? env.UTS_LOCAL_SECRETS === undefined : env.STS === undefined) {
    missing.push(development ? 'UTS_LOCAL_SECRETS' : 'STS');
  }
  const baseUrl = development ? config.loginRotation.cloudflareBaseUrl : CLOUDFLARE_API;
  if (baseUrl === null) missing.push('CLOUDFLARE_API_BASE_URL');
  if (manager === null || baseUrl === null || missing.length > 0) {
    return { status: 'misconfigured', missing };
  }
  return {
    status: 'on',
    timing: development ? developmentTiming(config.loginRotation.periodMs) : DEPLOYED_TIMING,
    manager,
    cloudflare: {
      baseUrl,
      accountId: CLOUDFLARE_ACCOUNT_ID,
      configIds: HYPERDRIVE_CONFIG_IDS[config.environment],
    },
  };
}
