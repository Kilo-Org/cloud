import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  USAGE_INGEST_URL,
  USAGE_INGEST_PUBLISH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import type { EnkryptUsageWriteInput, LlmUsageQueueMessage } from '@kilocode/usage-contracts';
import { enqueueVercelUsage } from '@kilocode/usage-queue/vercel/publisher';
import { USAGE_VERCEL_QUEUE_ENABLED } from '@kilocode/usage-queue/vercel/config';
import { getVercelExecutionRegion } from '@kilocode/worker-utils/vercel-execution-region';

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
 * `publisher_not_configured` means no publisher URL or secret is set, so nothing was attempted.
 * It is an operator error rather than a transport failure.
 */
export type UsageEnqueueOutcome = { kind: 'accepted' } | { kind: 'unavailable'; reason: string };

/** `usage_kind` labels the publisher logs of a tagged non-LLM usage kind; LLM logs omit it. */
type PublicationIdentity = { usageId: string; usage_kind?: 'enkrypt_usage' };

function reportUnavailable(
  identity: PublicationIdentity,
  reason: string,
  duplicatePossible = false
): UsageEnqueueOutcome {
  const outcome = { kind: 'unavailable', reason } as const;
  console.warn('usage enqueue unavailable', {
    ...identity,
    execution_region: getVercelExecutionRegion(),
    ...outcome,
    ...(duplicatePossible && { duplicate_possible: true }),
  });
  return outcome;
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

/**
 * `fetch` only speaks http(s). `new URL` accepts any `scheme:`, so a value like
 * `localhost:3000/usage` parses as a `localhost:` URL with no host and would fail every
 * attempt. Reject it as configuration before any request is made.
 */
function parsePublisherUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** HTTP 202 confirms enqueueing, not a committed usage row. */
export async function enqueueUsage(
  payload: LlmUsageQueueMessage,
  { retryTransientFailures = false }: { retryTransientFailures?: boolean } = {}
): Promise<UsageEnqueueOutcome> {
  if (USAGE_VERCEL_QUEUE_ENABLED) {
    return enqueueVercelUsage(payload);
  }
  return publishToUsageIngest({ usageId: payload.core.id }, USAGE_INGEST_URL, payload, {
    retryTransientFailures,
  });
}

const USAGE_INGEST_PATH = '/usage';
const ENKRYPT_USAGE_INGEST_PATH = '/enkrypt-usage';

/**
 * `USAGE_INGEST_URL` is documented as the Worker's `/usage` endpoint, and `/enkrypt-usage` is
 * its sibling on the same Worker. Any other shape cannot be mapped safely, so it counts as no
 * publisher at all.
 */
function enkryptUsageIngestUrl(usageIngestUrl: string | undefined): string | undefined {
  const url = usageIngestUrl ? parsePublisherUrl(usageIngestUrl) : null;
  if (!url || url.pathname !== USAGE_INGEST_PATH || url.search || url.hash) return undefined;
  url.pathname = ENKRYPT_USAGE_INGEST_PATH;
  return url.toString();
}

/**
 * Publishes the bare Enkrypt usage write to the usage-ingest `/enkrypt-usage` path, which wraps it
 * in the tagged queue envelope. Always Cloudflare HTTP with transient retries: the staging Vercel
 * queue carries LLM usage only.
 */
export async function enqueueEnkryptUsage(
  usageWrite: EnkryptUsageWriteInput
): Promise<UsageEnqueueOutcome> {
  return publishToUsageIngest(
    { usageId: usageWrite.id, usage_kind: 'enkrypt_usage' },
    enkryptUsageIngestUrl(USAGE_INGEST_URL),
    usageWrite,
    { retryTransientFailures: true }
  );
}

async function publishToUsageIngest(
  identity: PublicationIdentity,
  ingestUrl: string | undefined,
  payload: LlmUsageQueueMessage | EnkryptUsageWriteInput,
  { retryTransientFailures }: { retryTransientFailures: boolean }
): Promise<UsageEnqueueOutcome> {
  if (!ingestUrl || !USAGE_INGEST_PUBLISH_SECRET) {
    return reportUnavailable(identity, 'publisher_not_configured');
  }

  // A URL that is not an absolute http(s) endpoint is configuration, not transport: no
  // request is attempted, so the caller must fall back exactly like a missing publisher.
  const parsedUrl = parsePublisherUrl(ingestUrl);
  if (!parsedUrl) return reportUnavailable(identity, 'publisher_not_configured');
  const url = parsedUrl.toString();

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    // A validated usage record always serializes; keep the honest reason if it ever does not.
    return reportUnavailable(identity, 'request_failed');
  }

  const maxAttempts = retryTransientFailures ? USAGE_ENQUEUE_MAX_ATTEMPTS : 1;
  const publicationStartedAt = performance.now();
  const deadline = retryTransientFailures
    ? publicationStartedAt + USAGE_ENQUEUE_RETRY_BUDGET_MS
    : Number.POSITIVE_INFINITY;
  let reason = 'request_failed';
  let duplicatePossible = false;
  let priorBackoff: AttemptDiagnostic['priorBackoff'] = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingAttemptBudgetMs = Math.floor(deadline - performance.now());
    if (remainingAttemptBudgetMs <= 0) break;
    // Only the first retry-mode attempt gets the longer window; later attempts keep the per-retry
    // timeout, and every attempt is still clipped to what is left of the total budget.
    const attemptTimeoutMs =
      retryTransientFailures && attempt === 1
        ? USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS
        : retryTransientFailures
          ? USAGE_ENQUEUE_RETRY_TIMEOUT_MS
          : USAGE_ENQUEUE_TIMEOUT_MS;
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${USAGE_INGEST_PUBLISH_SECRET}`,
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
    const remainingBackoffBudgetMs = Math.floor(deadline - performance.now());
    if (remainingBackoffBudgetMs <= 0) break;
    const retryDelayMs = Math.min(
      Math.random() * Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)),
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
  }

  return reportUnavailable(identity, reason, duplicatePossible);
}
