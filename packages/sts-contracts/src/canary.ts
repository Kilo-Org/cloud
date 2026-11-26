import { z } from 'zod';
import { STS_DENIED_PROBE } from './scopes';
import type { MintDeniedReason } from './token';

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
/**
 * Each run the web route also asks STS for `STS_DENIED_PROBE`, a reserved scope no policy may
 * grant (`STS_RESERVED_SCOPES`). The scope is registered, so STS identifies the function, refuses
 * the token for this reason (`decide` in services/sts `src/tokens/mint.ts`: no policy lists the
 * audience `canary`) and records an `ai.kilo.sts.token.denied` row through `DenialDO`.
 */
export const STS_DENIED_PROBE_REASON = 'audience_not_allowed' satisfies MintDeniedReason;

/** The workload that sends the denied probe: the web app's canary route. */
export const STS_DENIED_PROBE_WORKLOAD = 'web';

/**
 * Whether the attributes of an `ai.kilo.sts.token.denied` event are the canary's denied probe:
 * actor workload `web` and scope `canary:denied-probe`. Every detection or alert rule over those
 * rows excludes exactly these and nothing broader, so the same caller's denial of any other scope,
 * and the probe scope asked for by any other workload, still count.
 */
export function isStsDeniedProbe(attributes: {
  readonly workload?: unknown;
  readonly scope?: unknown;
}): boolean {
  return (
    attributes.workload === STS_DENIED_PROBE_WORKLOAD && attributes.scope === STS_DENIED_PROBE.scope
  );
}

/**
 * `isStsDeniedProbe` as the APL line every Axiom query or monitor over `token.denied` rows in
 * `kilo-audit` (staging `kilo-audit-staging`) adds; the dataset flattens nested fields with dots.
 * `column_ifexists` keeps the query valid before any row carried the field (Axiom refuses a
 * field it has never seen), and `tostring` turns a missing value (a whole-call refusal names no
 * scope) into an empty string, so such a row is kept.
 */
export const STS_DENIED_PROBE_APL_EXCLUSION = `| where not(tostring(column_ifexists('data.attributes.workload', '')) == '${STS_DENIED_PROBE_WORKLOAD}' and tostring(column_ifexists('data.attributes.scope', '')) == '${STS_DENIED_PROBE.scope}')`;

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
 * usage-ingest of `STS_CANARY_VERIFY_CALL_TIMEOUT_MS` each, while the denied mint, one more 30 s
 * attempt, runs alongside them: 5 + 30 + max(4 x 10, 30) = 75 s. usage-ingest waits 80 s
 * (`WEB_CALL_TIMEOUT_MS` there), so it reads the route's report even in the slowest run, and the
 * route's 90 s `maxDuration`, after which Vercel ends the function, stays above both.
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

/**
 * One check: the HTTP status the web route got from usage-ingest, or null when it got none. The
 * denied mint's status is always null: the token client does not expose STS's HTTP status.
 */
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
 * instance holds none that old). `stsDenied` is STS refusing the web app the denied probe
 * (`STS_DENIED_PROBE`; `ok` only for `STS_DENIED_PROBE_REASON`); it runs every run, so it never
 * skips. The report never carries a token.
 */
export const StsCanaryReportSchema = z.strictObject({
  inbound: z.literal('ok'),
  outbound: StsCanaryCheckSchema,
  negatives: z.strictObject({
    wrongAudience: StsCanaryCheckSchema,
    forged: StsCanaryCheckSchema,
    expired: z.union([StsCanaryCheckSchema, z.literal('skipped')]),
    stsDenied: StsCanaryCheckSchema,
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
    (negatives.expired === 'skipped' || negatives.expired.result === 'ok') &&
    negatives.stsDenied.result === 'ok'
  );
}
