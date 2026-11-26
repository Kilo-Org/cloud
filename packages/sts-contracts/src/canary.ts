import { z } from 'zod';

/**
 * The STS canary pair (decision D6c): usage-ingest, a Worker with the `worker-binding` identity,
 * and the web app, a Vercel function with the `vercel-oidc` identity, each mint a token for the
 * other and verify the other's token, every 5 minutes, in production and staging.
 */

/** The token usage-ingest presents to the web app's canary route. */
export const WEB_CANARY_TOKEN = { audience: 'web', scope: 'web:sts.canary' } as const;
/** The token the web app presents to usage-ingest's verify route. */
export const USAGE_INGEST_CANARY_TOKEN = {
  audience: 'usage-ingest',
  scope: 'usage-ingest:sts.canary',
} as const;

/** usage-ingest's route that verifies a `usage-ingest:sts.canary` token and answers 204. */
export const STS_CANARY_VERIFY_PATH = '/sts-canary/verify';
/** One id per canary run, sent on every hop so the logs of both services join on it. */
export const STS_CANARY_RUN_HEADER = 'x-sts-canary-run';
export const StsCanaryRunIdSchema = z.uuid();

/**
 * Time budget of one canary run (services/usage-ingest README, "STS canary"). The web route
 * verifies the caller (a cold key-set fetch takes up to 5 s, `JWKS_FETCH_TIMEOUT_MS` of
 * `@kilocode/verify`), waits at most the HTTP client's 30 s attempt (`HTTP_ATTEMPT_TIMEOUT_MS` of
 * `@kilocode/service-token-client`, which ends both of its tries, the retry with a fresh Vercel
 * identity token after a refusal included, within that time), then makes at most four calls to
 * usage-ingest of `STS_CANARY_VERIFY_CALL_TIMEOUT_MS` each: 5 + 30 + 4 x 10 = 75 s. usage-ingest
 * waits 80 s (`WEB_CALL_TIMEOUT_MS` there), so it reads the route's report even in the slowest
 * run, and the route's 90 s `maxDuration`, after which Vercel ends the function, stays above both.
 */
export const STS_CANARY_VERIFY_CALL_TIMEOUT_MS = 10_000;
export const STS_CANARY_VERIFY_CALLS_MAX = 4;
/** `maxDuration` of the web route; Next.js needs the literal there, a test keeps the two equal. */
export const STS_CANARY_ROUTE_MAX_DURATION_SECONDS = 90;

/** Longest `detail` of a check; the web route truncates to it before it logs or answers. */
export const STS_CANARY_DETAIL_MAX = 200;

export function stsCanaryDetail(text: string): string {
  return text.length > STS_CANARY_DETAIL_MAX ? text.slice(0, STS_CANARY_DETAIL_MAX) : text;
}

/** One call the web route made to usage-ingest: the HTTP status it got, or null when it got none. */
export const StsCanaryCheckSchema = z.strictObject({
  result: z.enum(['ok', 'failed']),
  status: z.number().int().nullable(),
  /** Why a check failed, without a token: a mint denial reason, a refusal error, a timeout. */
  detail: z.string().max(STS_CANARY_DETAIL_MAX).optional(),
});
export type StsCanaryCheck = z.infer<typeof StsCanaryCheckSchema>;

/**
 * The web route's answer. `inbound` is the caller's token, which the route verified before it
 * answered at all. `outbound` is the web app's own token at usage-ingest (expect 204). The
 * negatives present tokens usage-ingest must refuse: the inbound `web` token (403
 * `insufficient_scope`), the outbound token's claims signed by a key STS never held (401), and an
 * earlier outbound token after its `exp` plus the verifier's skew (401; `skipped` while the
 * instance holds none that old). The report never carries a token.
 */
export const StsCanaryReportSchema = z.strictObject({
  inbound: z.literal('ok'),
  outbound: StsCanaryCheckSchema,
  negatives: z.strictObject({
    wrongAudience: StsCanaryCheckSchema,
    forged: StsCanaryCheckSchema,
    expired: z.union([StsCanaryCheckSchema, z.literal('skipped')]),
  }),
});
export type StsCanaryReport = z.infer<typeof StsCanaryReportSchema>;

/** Whether every check of a report passed; a skipped expired check counts as passed. */
export function stsCanaryPassed(report: StsCanaryReport): boolean {
  const { outbound, negatives } = report;
  return (
    outbound.result === 'ok' &&
    negatives.wrongAudience.result === 'ok' &&
    negatives.forged.result === 'ok' &&
    (negatives.expired === 'skipped' || negatives.expired.result === 'ok')
  );
}
