import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';

/**
 * `O11Y_API_METRICS_SENDER_AUTH`, the credential switch of the API-metrics sender to o11y
 * `POST /ingest/api-metrics`, set per Vercel project (`kilocode-app`, `kilocode-ai-gateway`):
 * - unset, empty or `legacy`: `O11Y_KILO_GATEWAY_CLIENT_SECRET` in `X-O11Y-ADMIN-TOKEN`, exactly as
 *   before this switch existed;
 * - `sts`: only an `o11y:api-metrics.write` STS service token in `Authorization: Bearer`, only to
 *   o11y's fixed origin in this deployment's STS environment; never the secret, and no return to it
 *   when the token or the send fails.
 * Any other value sends nothing. o11y must accept STS (`ADMIN_CREDENTIAL_ACCEPT=legacy-and-sts`
 * with its `STS_ENVIRONMENT`) before a sender moves to `sts`; rollback is this switch back to
 * `legacy`, before touching o11y.
 *
 * This module imports no STS code, so a `legacy` deployment never loads the token client or the
 * Vercel OIDC exchange; `api-metrics-sts.ts` holds them and is imported only for an STS send.
 */
export const ApiMetricsSenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('legacy')
);

/**
 * o11y's origin in each STS environment, the `RESOURCE_ORIGINS` of
 * `services/o11y/src/admin-middleware.ts`: the only place an STS token is sent. o11y has no isolated
 * staging deployment, so staging has none and sends nothing under `sts`.
 */
export const O11Y_STS_ORIGINS: Readonly<Partial<Record<StsEnvironment, string>>> = {
  production: 'https://o11y.kiloapps.io',
  development: 'http://localhost:8801',
};

/** The deployment's runtime variables; `process.env` itself in production. */
export type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

/**
 * The STS environment a deployment's tokens come from, the mapping of `services/sts/policy/web.yaml`
 * and `ai-gateway.yaml` (as `sts-secret-transport.ts`): Vercel production is production, the
 * `staging` custom environment is staging, a preview and a process outside Vercel are development.
 */
function stsEnvironmentOf(runtime: VercelRuntime): StsEnvironment | null {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === 'preview' && target === 'staging') return 'staging';
  if (environment === 'preview' && target === 'preview') return 'development';
  if (environment === undefined && target === undefined) return 'development';
  return null;
}

export type ApiMetricsSenderMisconfiguration =
  | 'invalid_auth'
  | 'no_sts_environment'
  | 'no_o11y_origin'
  | 'origin_mismatch';

/**
 * What this process sends with each metric, resolved once from its configuration:
 * - `off`: no endpoint, or `legacy` without the secret; nothing is sent, as before the switch;
 * - `legacy`: the secret in `X-O11Y-ADMIN-TOKEN`;
 * - `sts`: a token from `environment`'s STS in `Authorization`;
 * - `misconfigured`: the switch or the STS destination is invalid; nothing is sent.
 */
export type ApiMetricsSender =
  | { kind: 'off' }
  | { kind: 'legacy'; url: URL; secret: string }
  | { kind: 'sts'; url: URL; environment: StsEnvironment }
  | { kind: 'misconfigured'; reason: ApiMetricsSenderMisconfiguration };

/**
 * Under `sts` the endpoint's origin must be exactly o11y's origin of the deployment's own STS
 * environment: a URL of another environment or host sends nothing, so a token never reaches a
 * service that is not its audience.
 */
export function resolveApiMetricsSender(config: {
  auth: string | undefined;
  url: URL | null;
  secret: string | undefined;
  runtime: VercelRuntime;
}): ApiMetricsSender {
  const auth = ApiMetricsSenderAuthSchema.safeParse(config.auth);
  if (!auth.success) return { kind: 'misconfigured', reason: 'invalid_auth' };
  const { url } = config;
  if (url === null) return { kind: 'off' };
  if (auth.data === 'legacy') {
    return config.secret ? { kind: 'legacy', url, secret: config.secret } : { kind: 'off' };
  }
  const environment = stsEnvironmentOf(config.runtime);
  if (environment === null) return { kind: 'misconfigured', reason: 'no_sts_environment' };
  const origin = O11Y_STS_ORIGINS[environment];
  if (origin === undefined) return { kind: 'misconfigured', reason: 'no_o11y_origin' };
  if (url.origin !== origin) return { kind: 'misconfigured', reason: 'origin_mismatch' };
  return { kind: 'sts', url, environment };
}
