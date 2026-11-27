import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  USAGE_INGEST_URL,
  USAGE_INGEST_PUBLISH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import {
  toUsageRecordWireBody,
  type EnkryptUsageWriteInput,
  type ExaUsageRecord,
  type LlmUsageQueueMessage,
} from '@kilocode/usage-contracts';
import { parseInternalServiceUrl } from '@kilocode/web-shared/lib/internal-service-url';
import { getVercelExecutionRegion } from '@kilocode/worker-utils/vercel-execution-region';
import {
  stsPublishTarget,
  usagePublisherAuth,
  type PublishEnvironment,
} from '@kilocode/web-shared/lib/ai-gateway/usage-publish-credential';
import type {
  PublishToken,
  usagePublishToken,
} from '@kilocode/web-shared/lib/ai-gateway/usage-publish-token';

export const USAGE_ENQUEUE_TIMEOUT_MS = 2_000;
export const USAGE_ENQUEUE_MAX_ATTEMPTS = 4;
export const USAGE_ENQUEUE_RETRY_TIMEOUT_MS = 5_000;
/**
 * Observed ingress stalls of 5-10 s generally end in acceptance, so a longer first
 * confirmation avoids a duplicate send when acceptance takes that long. After #9865, stalls
 * that still retried ran roughly 12-21 s, so the first attempt now covers most of that range;
 * a stall longer than 20 s still duplicates. A lost first send is still retried; it is now
 * recovered about 10 s later than with a 10 s first attempt.
 */
export const USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS = 20_000;
/**
 * Four full windows plus maximum backoff take under 38.5 s, so a lost first send still gets
 * three full 5 s retries. The budget only shortens or skips an attempt when runtime scheduling
 * delays the loop.
 */
export const USAGE_ENQUEUE_RETRY_BUDGET_MS = 40_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 2_000;
/**
 * Under `USAGE_PUBLISHER_AUTH=sts`, how long after the publication starts the first token may
 * take: `USAGE_ENQUEUE_STS_FIRST_TOKEN_MS` with transient retries,
 * `USAGE_ENQUEUE_STS_SINGLE_FIRST_TOKEN_MS` for a single attempt, and never so long that less than
 * `USAGE_ENQUEUE_STS_FIRST_SEND_RESERVE_MS` of the publication's budget is left for the first
 * request. Counted inside the 2 s and 40 s budgets above. A token that arrives later is not used.
 * Without a usable token by then, no request has been launched, so the publication ends `not_sent`
 * and the caller's direct accounting runs at most this much later than for
 * `publisher_not_configured`; the token client's mint carries on under `waitUntil` for later
 * publications. Once a request was launched, a retry's token read may use whatever is left of the
 * 40 s budget.
 */
export const USAGE_ENQUEUE_STS_FIRST_TOKEN_MS = 2_000;
export const USAGE_ENQUEUE_STS_SINGLE_FIRST_TOKEN_MS = 1_000;
export const USAGE_ENQUEUE_STS_FIRST_SEND_RESERVE_MS = 1_000;

/**
 * `publisher_not_configured` means nothing was attempted: no publisher URL or secret is set, or
 * `USAGE_PUBLISHER_AUTH` or its STS destination is invalid. It is an operator error rather than a
 * transport failure.
 *
 * `not_sent` (only under `USAGE_PUBLISHER_AUTH=sts`) means STS denied the token or gave none within
 * the first-token window (see `USAGE_ENQUEUE_STS_FIRST_TOKEN_MS`), and no request was launched: the
 * event cannot be queued, so a direct write cannot duplicate it. Once any request was launched, a
 * later token failure ends `unavailable` with `sts_token_denied` or `sts_token_unavailable`, like
 * any other failure after a send.
 */
export type UsageEnqueueOutcome =
  | { kind: 'accepted' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not_sent'; reason: StsTokenFailure };

type StsTokenFailure = 'sts_token_denied' | 'sts_token_unavailable';

/** `usage_kind` labels the publisher logs of a tagged non-LLM usage kind; LLM logs omit it. */
type PublicationIdentity = { usageId: string; usage_kind?: 'enkrypt_usage' | 'exa_usage' };

function reportUnpublished<Outcome extends Exclude<UsageEnqueueOutcome, { kind: 'accepted' }>>(
  identity: PublicationIdentity,
  outcome: Outcome,
  duplicatePossible = false
): Outcome {
  console.warn('usage enqueue unavailable', {
    ...identity,
    execution_region: getVercelExecutionRegion(),
    ...outcome,
    ...(duplicatePossible && { duplicate_possible: true }),
  });
  return outcome;
}

function reportUnavailable(
  identity: PublicationIdentity,
  reason: string,
  duplicatePossible = false
): UsageEnqueueOutcome {
  return reportUnpublished(identity, { kind: 'unavailable', reason }, duplicatePossible);
}

/** Attempts at least this slow are always logged, like failed attempts and retries. */
const SLOW_ATTEMPT_LOG_THRESHOLD_MS = 1_000;

type AttemptDiagnostic = {
  identity: PublicationIdentity;
  attempt: number;
  maxAttempts: number;
  /** Set only when response headers arrived. */
  httpStatus: number | null;
  /** The existing categorical reason; null when the attempt was accepted. */
  reason: string | null;
  durationMs: number;
  timeoutMs: number;
  /** Null for single-attempt calls, which have no overall budget. */
  remainingBudgetMs: number | null;
  startOffsetMs: number;
  priorBackoff: { plannedMs: number; elapsedMs: number } | null;
};

/**
 * Same stable 1% bucket method as the usage-ingest consumer's delivery baseline. It uses no
 * randomness, so retry jitter is unaffected.
 */
function inStableOnePercentSample(usageId: string): boolean {
  let hash = 0;
  for (const char of usageId) {
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  }
  return hash % 100 === 0;
}

/**
 * One `usage_publisher_attempt` line per completed attempt. A fast accepted first attempt is
 * logged only for the stable 1% sample; everything else is logged every time.
 */
function reportAttempt(diagnostic: AttemptDiagnostic): void {
  const accepted = diagnostic.reason === null;
  const alwaysLogged =
    !accepted || diagnostic.attempt > 1 || diagnostic.durationMs >= SLOW_ATTEMPT_LOG_THRESHOLD_MS;
  if (!alwaysLogged && !inStableOnePercentSample(diagnostic.identity.usageId)) return;
  try {
    console.info(
      JSON.stringify({
        event: 'usage_publisher_attempt',
        sample_rate: alwaysLogged ? 1 : 0.01,
        usage_id: diagnostic.identity.usageId,
        ...(diagnostic.identity.usage_kind && { usage_kind: diagnostic.identity.usage_kind }),
        execution_region: getVercelExecutionRegion(),
        attempt: diagnostic.attempt,
        max_attempts: diagnostic.maxAttempts,
        accepted,
        attempt_end:
          diagnostic.httpStatus !== null
            ? 'response_headers'
            : diagnostic.reason === 'timeout'
              ? 'timeout'
              : 'network_error',
        ...(diagnostic.httpStatus !== null && { http_status: diagnostic.httpStatus }),
        ...(diagnostic.reason !== null && { reason: diagnostic.reason }),
        duration_ms: Math.round(diagnostic.durationMs),
        timeout_ms: diagnostic.timeoutMs,
        ...(diagnostic.remainingBudgetMs !== null && {
          remaining_budget_ms: diagnostic.remainingBudgetMs,
        }),
        start_offset_ms: Math.round(diagnostic.startOffsetMs),
        ...(diagnostic.priorBackoff && {
          prior_backoff_planned_ms: Math.round(diagnostic.priorBackoff.plannedMs),
          prior_backoff_elapsed_ms: Math.round(diagnostic.priorBackoff.elapsedMs),
        }),
      })
    );
  } catch (error) {
    // The attempt line was not written. Report the logging failure to Sentry and let the
    // publication continue with the outcome it already has.
    captureException(error, { level: 'warning', tags: { source: 'usage_publisher_attempt_log' } });
  }
}

/** HTTP 202 confirms enqueueing, not a committed usage row. */
export async function enqueueUsage(
  payload: LlmUsageQueueMessage,
  { retryTransientFailures = false }: { retryTransientFailures?: boolean } = {}
): Promise<UsageEnqueueOutcome> {
  return publishToUsageIngest(
    { usageId: payload.core.id },
    USAGE_INGEST_PATH,
    toUsageRecordWireBody(payload),
    {
      retryTransientFailures,
    }
  );
}

const USAGE_INGEST_PATH = '/usage';
const ENKRYPT_USAGE_INGEST_PATH = '/enkrypt-usage';
const EXA_USAGE_INGEST_PATH = '/exa-usage';
type IngestPath =
  | typeof USAGE_INGEST_PATH
  | typeof ENKRYPT_USAGE_INGEST_PATH
  | typeof EXA_USAGE_INGEST_PATH;

/**
 * `USAGE_INGEST_URL` is documented as the Worker's `/usage` endpoint, and each tagged kind's path
 * is its sibling on the same Worker. Any other shape cannot be mapped safely, so it counts as no
 * publisher at all.
 */
export function usageIngestSiblingUrl(
  usageIngestUrl: string | undefined,
  siblingPath: string
): string | undefined {
  const url = usageIngestUrl ? parseInternalServiceUrl(usageIngestUrl) : null;
  if (!url || url.pathname !== USAGE_INGEST_PATH || url.search || url.hash) return undefined;
  url.pathname = siblingPath;
  return url.toString();
}

/**
 * Publishes the bare Enkrypt usage write to the usage-ingest `/enkrypt-usage` path, which wraps it
 * in the tagged queue envelope. Always Cloudflare HTTP with transient retries.
 */
export async function enqueueEnkryptUsage(
  usageWrite: EnkryptUsageWriteInput
): Promise<UsageEnqueueOutcome> {
  return publishToUsageIngest(
    { usageId: usageWrite.id, usage_kind: 'enkrypt_usage' },
    ENKRYPT_USAGE_INGEST_PATH,
    usageWrite,
    { retryTransientFailures: true }
  );
}

/**
 * True when the Exa queue fallback would attempt a publication: under `legacy` the ingest URL
 * maps to the sibling `/exa-usage` path and the publish secret is set; under `sts` the STS
 * destination is valid. Callers use this to avoid reserving invocation time for a publication
 * that cannot happen.
 */
export function isExaUsagePublicationConfigured(): boolean {
  return publisherCredential(EXA_USAGE_INGEST_PATH) !== null;
}

/**
 * Publishes the bare Exa usage record, with its `id` and `occurredAt` unchanged, to the
 * usage-ingest `/exa-usage` path, which wraps it in the tagged queue envelope. Like Enkrypt it is
 * always Cloudflare HTTP with transient retries of the same serialized body.
 */
export async function enqueueExaUsage(record: ExaUsageRecord): Promise<UsageEnqueueOutcome> {
  return publishToUsageIngest(
    { usageId: record.id, usage_kind: 'exa_usage' },
    EXA_USAGE_INGEST_PATH,
    record,
    { retryTransientFailures: true }
  );
}

type PublisherCredential =
  | { kind: 'secret'; url: string; secret: string }
  | { kind: 'sts'; url: string; environment: PublishEnvironment };

type UsagePublishTokenReader = typeof usagePublishToken;

/**
 * Loads the STS token reader, and with it the token client, the Vercel OIDC exchange and the STS
 * contracts, only for an STS publication, within `budgetMs` of the token window: null when it fails
 * or is not loaded in time. No promise outlives the publication; the module itself is cached by the
 * runtime once loaded.
 */
async function loadUsagePublishToken(budgetMs: number): Promise<UsagePublishTokenReader | null> {
  const loaded = import('@kilocode/web-shared/lib/ai-gateway/usage-publish-token').then(
    module => module.usagePublishToken,
    () => null
  );
  const late = Promise.withResolvers<null>();
  const timer = setTimeout(() => late.resolve(null), Math.max(0, budgetMs));
  try {
    return await Promise.race([loaded, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where `path` is published and with which credential, decided before any token or request; null
 * when nothing may be sent. Under `sts` the URL is the fixed origin of the deployment's own
 * environment plus `path`, never the configured URL itself, and the secret is never sent.
 */
function publisherCredential(path: IngestPath): PublisherCredential | null {
  const auth = usagePublisherAuth(process.env.USAGE_PUBLISHER_AUTH);
  if (auth === null) return null;
  if (auth === 'sts') {
    const target = stsPublishTarget(
      { VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV },
      USAGE_INGEST_URL
    );
    return (
      target && { kind: 'sts', url: `${target.origin}${path}`, environment: target.environment }
    );
  }
  const ingestUrl =
    path === USAGE_INGEST_PATH ? USAGE_INGEST_URL : usageIngestSiblingUrl(USAGE_INGEST_URL, path);
  if (!ingestUrl || !USAGE_INGEST_PUBLISH_SECRET) return null;
  // A URL that is not an absolute http(s) endpoint is configuration, not transport: no
  // request is attempted, so the caller must fall back exactly like a missing publisher.
  const parsedUrl = parseInternalServiceUrl(ingestUrl);
  return (
    parsedUrl && { kind: 'secret', url: parsedUrl.toString(), secret: USAGE_INGEST_PUBLISH_SECRET }
  );
}

async function publishToUsageIngest(
  identity: PublicationIdentity,
  path: IngestPath,
  payload: LlmUsageQueueMessage | EnkryptUsageWriteInput | ExaUsageRecord,
  { retryTransientFailures }: { retryTransientFailures: boolean }
): Promise<UsageEnqueueOutcome> {
  const credential = publisherCredential(path);
  if (!credential) return reportUnavailable(identity, 'publisher_not_configured');

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    // A validated usage record always serializes; keep the honest reason if it ever does not.
    return reportUnavailable(identity, 'request_failed');
  }

  const maxAttempts = retryTransientFailures ? USAGE_ENQUEUE_MAX_ATTEMPTS : 1;
  const publicationStartedAt = performance.now();
  // An STS single attempt fits its token (at most 1 s) and its send (at least 1 s) into one 2 s
  // window.
  const deadline = retryTransientFailures
    ? publicationStartedAt + USAGE_ENQUEUE_RETRY_BUDGET_MS
    : credential.kind === 'sts'
      ? publicationStartedAt + USAGE_ENQUEUE_TIMEOUT_MS
      : Number.POSITIVE_INFINITY;
  // Under STS the first token must be in hand by here, which leaves the first request its reserve.
  const firstTokenDeadline = Math.min(
    publicationStartedAt +
      (retryTransientFailures
        ? USAGE_ENQUEUE_STS_FIRST_TOKEN_MS
        : USAGE_ENQUEUE_STS_SINGLE_FIRST_TOKEN_MS),
    deadline - USAGE_ENQUEUE_STS_FIRST_SEND_RESERVE_MS
  );
  let reason = 'request_failed';
  let duplicatePossible = false;
  let priorBackoff: AttemptDiagnostic['priorBackoff'] = null;
  /** Set just before the first request goes to `fetch`; from then on a no-send end is unsafe. */
  let launched = false;
  /** Loaded at this publication's first token read; null until then or when it could not load. */
  let readToken: UsagePublishTokenReader | null = null;

  /**
   * Waits before the next attempt, never less than `minimumDelayMs`; false, without waiting, when
   * the budget cannot cover that wait.
   */
  async function backOff(attempt: number, minimumDelayMs: number): Promise<boolean> {
    const remainingBackoffBudgetMs = Math.floor(deadline - performance.now());
    if (remainingBackoffBudgetMs <= 0 || minimumDelayMs >= remainingBackoffBudgetMs) return false;
    const retryDelayMs = Math.min(
      Math.max(
        minimumDelayMs,
        Math.random() * Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
      ),
      remainingBackoffBudgetMs
    );
    console.warn('usage enqueue retrying', {
      ...identity,
      execution_region: getVercelExecutionRegion(),
      reason,
      attempt,
      ...(duplicatePossible && { duplicate_possible: true }),
    });
    const backoffStartedAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    priorBackoff = { plannedMs: retryDelayMs, elapsedMs: performance.now() - backoffStartedAt };
    return true;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let remainingAttemptBudgetMs = Math.floor(deadline - performance.now());
    if (remainingAttemptBudgetMs <= 0) break;
    // Only the first retry-mode attempt gets the longer window; later attempts keep the per-retry
    // timeout, and every attempt is still clipped to what is left of the total budget.
    const attemptTimeoutMs =
      retryTransientFailures && attempt === 1
        ? USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS
        : retryTransientFailures
          ? USAGE_ENQUEUE_RETRY_TIMEOUT_MS
          : USAGE_ENQUEUE_TIMEOUT_MS;
    let authorization: string;
    if (credential.kind === 'secret') {
      authorization = `Bearer ${credential.secret}`;
    } else {
      // Read for every attempt, so no send carries a token the client would no longer serve.
      // Until a request is launched, the module load and the read end with the first-token window.
      const tokenDeadline = launched ? deadline : firstTokenDeadline;
      readToken ??= await loadUsagePublishToken(Math.floor(tokenDeadline - performance.now()));
      const token: PublishToken = readToken
        ? await readToken(credential.environment, Math.floor(tokenDeadline - performance.now()))
        : { kind: 'unavailable', retryAfterMs: 0 };
      const tokenReadAt = performance.now();
      remainingAttemptBudgetMs = Math.floor(deadline - tokenReadAt);
      // A first token that came back after its window, so after the send reserve too, is not used.
      const lateFirstToken = !launched && tokenReadAt > firstTokenDeadline;
      if (token.kind !== 'token' || lateFirstToken || remainingAttemptBudgetMs <= 0) {
        const tokenFailure: StsTokenFailure =
          token.kind === 'denied' ? 'sts_token_denied' : 'sts_token_unavailable';
        // Nothing was ever launched, so nothing can be queued: the caller may account directly.
        if (!launched) {
          return reportUnpublished(identity, { kind: 'not_sent', reason: tokenFailure });
        }
        // An earlier request may already be queued, so this ends like any failure after a send.
        reason = tokenFailure;
        if (token.kind === 'denied' || attempt === maxAttempts) break;
        const retryAfterMs = token.kind === 'unavailable' ? token.retryAfterMs : 0;
        if (!(await backOff(attempt, retryAfterMs))) break;
        continue;
      }
      authorization = `Bearer ${token.token}`;
    }
    const signalTimeoutMs = Math.min(attemptTimeoutMs, remainingAttemptBudgetMs);
    const signal = AbortSignal.timeout(signalTimeoutMs);
    const attemptStartedAt = performance.now();
    const attemptContext = {
      identity,
      attempt,
      maxAttempts,
      timeoutMs: signalTimeoutMs,
      remainingBudgetMs: retryTransientFailures ? remainingAttemptBudgetMs : null,
      startOffsetMs: attemptStartedAt - publicationStartedAt,
      priorBackoff,
    };
    let retryable: boolean;
    let httpStatus: number | null = null;
    let headersReceivedAt: number | null = null;
    try {
      launched = true;
      const response = await fetch(credential.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: authorization,
        },
        body,
        signal,
        cache: 'no-store',
        redirect: 'manual',
      });
      headersReceivedAt = performance.now();
      httpStatus = response.status;
      // Cancel unused bodies without allowing asynchronous cleanup failures to change acceptance.
      void response.body?.cancel().catch(() => {});
      if (response.status === 202) {
        reportAttempt({
          ...attemptContext,
          httpStatus,
          reason: null,
          durationMs: headersReceivedAt - attemptStartedAt,
        });
        return { kind: 'accepted' };
      }
      reason = `http_${response.status}`;
      // 408 and 429 refuse the request before it is enqueued. A 5xx can follow a
      // `Queue.send` that stored the message before failing, or an edge failure after
      // the Worker ran, so like a lost response it may hide an accepted event.
      duplicatePossible ||= response.status >= 500;
      retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    } catch {
      reason = signal.aborted ? 'timeout' : 'request_failed';
      duplicatePossible = true;
      retryable = true;
    }
    reportAttempt({
      ...attemptContext,
      httpStatus,
      reason,
      durationMs: (headersReceivedAt ?? performance.now()) - attemptStartedAt,
    });

    if (!retryable || attempt === maxAttempts) break;
    if (!(await backOff(attempt, 0))) break;
  }

  return reportUnavailable(identity, reason, duplicatePossible);
}
