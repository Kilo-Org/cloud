import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';

/**
 * `O11Y_API_METRICS_SENDER_AUTH`, the credential switch of the API-metrics sender to o11y
 * `POST /ingest/api-metrics`, set per Vercel project (`kilocode-app`, `kilocode-ai-gateway`):
 * - unset, empty or `legacy`: `O11Y_KILO_GATEWAY_CLIENT_SECRET` in `X-O11Y-ADMIN-TOKEN`, exactly as
 *   before this switch existed;
 * - `sts`, Vercel production only: only an `o11y:api-metrics.write` STS service token in
 *   `Authorization: Bearer`, only to o11y's production origin; never the secret, and no return to
 *   it when the token or the send fails. o11y has no staging or preview deployment, so a staging or
 *   preview deployment set to `sts` sends nothing. A process outside Vercel (local development)
 *   uses development STS and o11y's local origin.
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
 * o11y's origin in each STS environment it serves, the `RESOURCE_ORIGINS` of
 * `services/o11y/src/admin-middleware.ts`: the only places an STS token is sent.
 */
export const O11Y_STS_ORIGINS = {
  production: 'https://o11y.kiloapps.io',
  development: 'http://localhost:8801',
} as const satisfies Partial<Record<StsEnvironment, string>>;

export type O11yStsEnvironment = keyof typeof O11Y_STS_ORIGINS;

/** The deployment's runtime variables; `process.env` itself in production. */
export type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

/**
 * The STS environment an `sts` sender to o11y mints from: Vercel production is production, and a
 * process outside Vercel (local development) is development. Every other deployment, the `staging`
 * custom environment and previews included, has none: o11y has no deployment there. The API-metrics
 * and admin-alerting senders both use it.
 */
export function o11yStsEnvironmentOf(runtime: VercelRuntime): O11yStsEnvironment | null {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === undefined && target === undefined) return 'development';
  return null;
}

export type ApiMetricsSenderMisconfiguration = 'invalid_auth' | 'origin_mismatch';

/**
 * What this process sends with each metric, resolved once from its configuration:
 * - `off`: nothing is sent. `unconfigured`: no endpoint, or `legacy` without the secret, as before
 *   the switch. `sts_production_only`: `sts` on a deployment o11y does not serve (staging, preview);
 * - `legacy`: the secret in `X-O11Y-ADMIN-TOKEN`;
 * - `sts`: a token from `environment`'s STS in `Authorization`;
 * - `misconfigured`: the switch or the STS destination is invalid; nothing is sent.
 */
export type ApiMetricsSender =
  | { kind: 'off'; reason: 'unconfigured' | 'sts_production_only' }
  | { kind: 'legacy'; url: URL; secret: string }
  | { kind: 'sts'; url: URL; environment: O11yStsEnvironment }
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
  if (url === null) return { kind: 'off', reason: 'unconfigured' };
  if (auth.data === 'legacy') {
    return config.secret
      ? { kind: 'legacy', url, secret: config.secret }
      : { kind: 'off', reason: 'unconfigured' };
  }
  const environment = o11yStsEnvironmentOf(config.runtime);
  if (environment === null) return { kind: 'off', reason: 'sts_production_only' };
  if (url.origin !== O11Y_STS_ORIGINS[environment]) {
    return { kind: 'misconfigured', reason: 'origin_mismatch' };
  }
  return { kind: 'sts', url, environment };
}
