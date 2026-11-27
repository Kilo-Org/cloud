import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';

/**
 * The proxy's configuration, from its wrangler vars (contract §3, §11 B). Everything that depends
 * on which environment this deployment serves derives from one constant,
 * `MIGRATION_PROXY_ENVIRONMENT`: the login rules below and the attestation re-check
 * (`expectedRun`, §5 step 2). It has no default. A refused config answers `config_invalid` and
 * starts nothing, neither a run nor a sample.
 */

export type LoginMode = 'member' | 'direct';
export type SessionKey = 'label' | 'pid';

export type ProxyConfig = {
  environment: StsEnvironment;
  target: { host: string; port: 5432; database: string };
  /** The login as configured; through a pooler it carries a `.<project ref>` suffix. */
  user: string;
  loginMode: LoginMode;
  sessionKey: SessionKey;
  /** Minutes between sampled checks while idle; 0 turns the check off. */
  sampleMinutes: number;
  runDeadlineSeconds: number;
  github: { appId: string; installationId: string };
  /** The review base of an environment's first run (§5 step 5). */
  reviewBaselineSha: string;
};

export type ConfigResult = { ok: true; config: ProxyConfig } | { ok: false; problems: string[] };

/** The dedicated production login (§3, member mode), bare or with a pooler's project ref. */
const MEMBER_LOGIN = /^kilo_migration_proxy(\.[a-z]{20})?$/;
const MAX_RUN_DEADLINE_SECONDS = 21_600;
const TARGET = /^([a-z0-9.-]+):([0-9]{1,5})\/([a-z0-9_]+)$/;
const DECIMAL_ID = /^[0-9]{1,20}$/;
const SHA = /^[0-9a-f]{40}$/;

const VarsSchema = z.object({
  MIGRATION_PROXY_ENVIRONMENT: z.enum(['production', 'staging', 'development']),
  MIGRATION_DB_TARGET: z.string(),
  MIGRATION_DB_USER: z.string().min(1),
  MIGRATION_DB_LOGIN_MODE: z.enum(['member', 'direct']),
  MIGRATION_SESSION_KEY: z.enum(['label', 'pid']),
  MIGRATION_SESSION_SAMPLE_MINUTES: z.string().regex(/^[0-9]{1,4}$/),
  MIGRATION_RUN_DEADLINE_SECONDS: z.string().regex(/^[0-9]{1,5}$/),
  MIGRATION_PROXY_GITHUB_APP_ID: z.string(),
  MIGRATION_PROXY_GITHUB_INSTALLATION_ID: z.string(),
  MIGRATION_REVIEW_BASELINE_SHA: z.string(),
});

/** Reads and checks the vars; the problems name vars and rules, never a value. */
export function readConfig(vars: Record<string, unknown>): ConfigResult {
  const parsed = VarsSchema.safeParse(vars);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`),
    };
  }
  const v = parsed.data;
  const problems: string[] = [];
  const environment = v.MIGRATION_PROXY_ENVIRONMENT;
  const loginMode = v.MIGRATION_DB_LOGIN_MODE;
  const sessionKey = v.MIGRATION_SESSION_KEY;
  const sampleMinutes = Number(v.MIGRATION_SESSION_SAMPLE_MINUTES);
  const runDeadlineSeconds = Number(v.MIGRATION_RUN_DEADLINE_SECONDS);

  // Never Hyperdrive and never 6543, Supabase's transaction-mode port (§2).
  const target = TARGET.exec(v.MIGRATION_DB_TARGET);
  if (target === null) problems.push('MIGRATION_DB_TARGET: not <host>:5432/<database>');
  else if (target[2] !== '5432') problems.push('MIGRATION_DB_TARGET: port must be 5432');

  // Barrier 1 of the production refusal of direct mode (§3).
  if (environment === 'production') {
    if (loginMode !== 'member') {
      problems.push('MIGRATION_DB_LOGIN_MODE: production runs member mode only');
    }
    if (!MEMBER_LOGIN.test(v.MIGRATION_DB_USER)) {
      problems.push(
        'MIGRATION_DB_USER: production logs in as kilo_migration_proxy or kilo_migration_proxy.<ref> only'
      );
    }
  }
  // Direct mode logs in as postgres itself: only recorded pairs may be ended, and no sample runs,
  // since every other postgres session would count as unexpected (§3).
  if (loginMode === 'direct') {
    if (sessionKey !== 'pid') problems.push('MIGRATION_SESSION_KEY: direct mode requires pid');
    if (sampleMinutes !== 0) {
      problems.push('MIGRATION_SESSION_SAMPLE_MINUTES: direct mode requires 0');
    }
  }
  if (runDeadlineSeconds < 60 || runDeadlineSeconds > MAX_RUN_DEADLINE_SECONDS) {
    problems.push('MIGRATION_RUN_DEADLINE_SECONDS: must be 60 to 21600');
  }
  // Set by slice E; until then every run is refused.
  if (!DECIMAL_ID.test(v.MIGRATION_PROXY_GITHUB_APP_ID)) {
    problems.push('MIGRATION_PROXY_GITHUB_APP_ID: not set');
  }
  if (!DECIMAL_ID.test(v.MIGRATION_PROXY_GITHUB_INSTALLATION_ID)) {
    problems.push('MIGRATION_PROXY_GITHUB_INSTALLATION_ID: not set');
  }
  if (!SHA.test(v.MIGRATION_REVIEW_BASELINE_SHA)) {
    problems.push('MIGRATION_REVIEW_BASELINE_SHA: not set');
  }

  if (problems.length > 0 || target === null) return { ok: false, problems };
  return {
    ok: true,
    config: {
      environment,
      target: { host: target[1], port: 5432, database: target[3] },
      user: v.MIGRATION_DB_USER,
      loginMode,
      sessionKey,
      sampleMinutes,
      runDeadlineSeconds,
      github: {
        appId: v.MIGRATION_PROXY_GITHUB_APP_ID,
        installationId: v.MIGRATION_PROXY_GITHUB_INSTALLATION_ID,
      },
      reviewBaselineSha: v.MIGRATION_REVIEW_BASELINE_SHA,
    },
  };
}

export const REPOSITORY = {
  fullName: 'Kilo-Org/cloud',
  id: '1145038391',
  ownerId: '201822503',
} as const;

export const ALLOWED_EVENTS: readonly string[] = ['workflow_run', 'schedule', 'workflow_dispatch'];

/**
 * §5 step 2: the attested claims a run must carry, from the same environment constant as the
 * login rules. The local stack (`development`) rehearses staging's identity.
 */
export function expectedRun(environment: StsEnvironment): {
  environment: string;
  jobWorkflowRef: string;
  workload: string;
} {
  if (environment === 'production') {
    return {
      environment: 'production',
      jobWorkflowRef: `${REPOSITORY.fullName}/.github/workflows/deploy-production.yml@refs/heads/main`,
      workload: 'ci-db-migrate',
    };
  }
  return {
    environment: 'staging',
    jobWorkflowRef: `${REPOSITORY.fullName}/.github/workflows/deploy-staging.yml@refs/heads/main`,
    workload: 'ci-db-migrate-staging',
  };
}
