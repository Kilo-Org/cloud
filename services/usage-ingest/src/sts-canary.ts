import {
  createWorkerServiceTokens,
  HTTP_ATTEMPT_TIMEOUT_MS,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import {
  STS_CANARY_VERIFY_CALL_TIMEOUT_MS,
  STS_CANARY_VERIFY_CALLS_MAX,
  STS_CANARY_RUN_HEADER,
  STS_ISSUERS,
  StsCanaryReportSchema,
  StsCanaryRunIdSchema,
  USAGE_INGEST_CANARY_TOKEN,
  WEB_CANARY_TOKEN,
  stsCanaryPassed,
  type StsCanaryCheck,
  type StsCanaryReport,
} from '@kilocode/sts-contracts';
import {
  createVerifier,
  failureResponse,
  httpJwksSource,
  JWKS_FETCH_TIMEOUT_MS,
  type Verifier,
} from '@kilocode/verify';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRunContext,
  emitScheduledJobEvent,
  type ScheduledJobMetadata,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { logSafely } from './diagnostics';

/**
 * The STS canary (decision D6c, services/usage-ingest README "STS canary"). It never touches the
 * usage publish or consume paths, their queues or their credentials.
 */
export type StsCanaryEnv = {
  STS?: MintBinding;
  /** Exactly `true` runs the scheduled canary; anything else, absent included, skips it. */
  STS_CANARY_ENABLED?: string;
  /** The STS issuer: the `iss` the verify route accepts and the base of its key-set URL. */
  STS_URL?: string;
  WEB_STS_CANARY_URL?: string;
  /** Staging only: the web app's staging deployment sits behind Vercel deployment protection. */
  USAGE_WRITER_PROTECTION_BYPASS?: string;
};

export const STS_CANARY_JOB_NAME = 'usage_ingest.sts_canary';
/**
 * The web route's slowest run: a cold key-set fetch to verify this Worker's token
 * (`JWKS_FETCH_TIMEOUT_MS`, 5 s), one mint attempt (`HTTP_ATTEMPT_TIMEOUT_MS`, 30 s), then four
 * calls to this Worker (`STS_CANARY_VERIFY_CALL_TIMEOUT_MS`, 10 s each): 5 + 30 + 4 x 10 = 75 s.
 * This Worker waits 5 s past that, 80 s, under the route's 90 s `maxDuration`
 * (`STS_CANARY_ROUTE_MAX_DURATION_SECONDS`), so even the slowest run lands its report here.
 */
export const WEB_CALL_TIMEOUT_MS =
  JWKS_FETCH_TIMEOUT_MS +
  HTTP_ATTEMPT_TIMEOUT_MS +
  STS_CANARY_VERIFY_CALLS_MAX * STS_CANARY_VERIFY_CALL_TIMEOUT_MS +
  5_000;

/** One client per isolate, keyed by the binding, so every run after the first reuses its token. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}

/**
 * One verifier per isolate for the configured issuer. The resource metadata URL names this
 * Worker's own origin; it appears only in 401 challenges.
 */
let verifier: { key: string; instance: Verifier<false> } | null = null;

function verifierFor(stsUrl: string, origin: string): Verifier<false> {
  const key = `${stsUrl}|${origin}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      instance: createVerifier({
        audience: USAGE_INGEST_CANARY_TOKEN.audience,
        resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource`,
        sts: { issuer: stsUrl, jwks: httpJwksSource(stsUrl) },
      }),
    };
  }
  return verifier.instance;
}

function runIdOf(request: Request): string | undefined {
  const parsed = StsCanaryRunIdSchema.safeParse(request.headers.get(STS_CANARY_RUN_HEADER));
  return parsed.success ? parsed.data : undefined;
}

/**
 * `POST /sts-canary/verify`: 204 for a valid `usage-ingest:sts.canary` STS token, otherwise the
 * design section 7 refusal. Logs each outcome without the token.
 */
export async function handleStsCanaryVerify(
  request: Request,
  env: StsCanaryEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (!env.STS_URL) {
    return Response.json({ error: 'STS_URL is not configured' }, { status: 503 });
  }
  const waitUntil = (promise: Promise<unknown>) => {
    if (ctx === undefined) void promise;
    else ctx.waitUntil(promise);
  };
  const result = await verifierFor(env.STS_URL, new URL(request.url).origin).verify(
    request,
    { issuer: 'sts', scope: USAGE_INGEST_CANARY_TOKEN.scope },
    { waitUntil }
  );
  const run = runIdOf(request);
  if (!result.ok) {
    logSafely('warn', () => ({
      event: 'sts_canary_verify_refused',
      run,
      status: result.status,
      error: result.error,
      reason: result.reason,
    }));
    return failureResponse(result);
  }
  logSafely('info', () => ({
    event: 'sts_canary_verify_accepted',
    run,
    caller: result.caller.kind === 'service' ? result.caller.workload : result.caller.kind,
  }));
  return new Response(null, { status: 204 });
}

class StsCanaryError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

function checkMetadata(prefix: string, check: StsCanaryCheck | 'skipped'): ScheduledJobMetadata {
  if (check === 'skipped') return { [`${prefix}_result`]: 'skipped' };
  return {
    [`${prefix}_result`]: check.result,
    [`${prefix}_status`]: check.status ?? undefined,
    [`${prefix}_detail`]: check.detail,
  };
}

function reportMetadata(report: StsCanaryReport): ScheduledJobMetadata {
  return {
    inbound_result: report.inbound,
    ...checkMetadata('outbound', report.outbound),
    ...checkMetadata('negative_wrong_audience', report.negatives.wrongAudience),
    ...checkMetadata('negative_forged', report.negatives.forged),
    ...checkMetadata('negative_expired', report.negatives.expired),
  };
}

function environmentOf(stsUrl: string | undefined): string | undefined {
  return Object.entries(STS_ISSUERS).find(([, issuer]) => issuer === stsUrl)?.[0];
}

/** Mints, calls the web route, and reads its report; throws a named error at the first failure. */
async function runChecks(
  env: StsCanaryEnv,
  ctx: ExecutionContext,
  runId: string,
  metadata: ScheduledJobMetadata
): Promise<void> {
  if (env.STS === undefined || !env.WEB_STS_CANARY_URL) {
    throw new StsCanaryError('StsCanaryNotConfigured', 'STS or WEB_STS_CANARY_URL is missing');
  }
  let token: string;
  try {
    token = await tokensFor(env.STS).get(WEB_CANARY_TOKEN, ctx);
    metadata.mint_result = 'issued';
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      metadata.mint_result = error.reason;
      metadata.mint_detail = error.deniedReason ?? `retry_after_${error.retryAfterSeconds}s`;
    }
    throw error;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    [STS_CANARY_RUN_HEADER]: runId,
  };
  if (env.USAGE_WRITER_PROTECTION_BYPASS) {
    headers['x-vercel-protection-bypass'] = env.USAGE_WRITER_PROTECTION_BYPASS;
  }
  // The request carries the token and, in staging, the bypass secret: a redirect is never
  // followed, it fails the run.
  const response = await fetch(env.WEB_STS_CANARY_URL, {
    method: 'POST',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(WEB_CALL_TIMEOUT_MS),
  });
  metadata.web_status = response.status;
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new StsCanaryError('StsCanaryWebRefused', `the web route answered ${response.status}`);
  }
  const report = StsCanaryReportSchema.safeParse(await response.json().catch(() => null));
  if (!report.success) {
    throw new StsCanaryError('StsCanaryReportInvalid', 'the web route answered no valid report');
  }
  Object.assign(metadata, reportMetadata(report.data));
  if (!stsCanaryPassed(report.data)) {
    throw new StsCanaryError('StsCanaryCheckFailed', 'a check of the web route failed');
  }
}

/**
 * The scheduled run: one `scheduled_job.completed` event (job `usage_ingest.sts_canary`) with the
 * outcome and each check's result and status, never a token. Skipped entirely unless enabled.
 */
export async function runStsCanary(
  controller: Pick<ScheduledController, 'cron' | 'scheduledTime'>,
  env: StsCanaryEnv,
  ctx: ExecutionContext
): Promise<void> {
  if (env.STS_CANARY_ENABLED !== 'true') return;
  const context = createScheduledJobRunContext();
  const metadata: ScheduledJobMetadata = {
    schedule: controller.cron,
    scheduled_time: controller.scheduledTime,
  };
  const event = { context, jobName: STS_CANARY_JOB_NAME, environment: environmentOf(env.STS_URL) };
  try {
    await runChecks(env, ctx, context.runId, metadata);
    emitScheduledJobEvent(buildScheduledJobSuccessEvent({ ...event, metadata }));
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent({ ...event, metadata, error }));
  }
}
