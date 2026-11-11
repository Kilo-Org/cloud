import type { GetProviderProviderResult } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { ByokFailoverAttempt } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  sendUpstreamAttempt,
  type SendUpstreamAttemptInput,
  type SendUpstreamAttemptResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import { UPSTREAM_DURATION_BUDGET_MS } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';

const MIN_FAILOVER_BUDGET_MS = 30_000;
const ERROR_BODY_READ_TIMEOUT_MS = 1_000;
const MAX_ERROR_BODY_CHARS = 16 * 1024;
const ERROR_CODE_PATTERN = /^[\w.:-]{1,64}$/;

type ByokFailoverResult = {
  attempt: SendUpstreamAttemptResult;
  /** The route that sent the returned attempt. */
  providerContext: GetProviderProviderResult;
  /** The request as sent for the returned attempt. */
  request: GatewayRequest;
  /** Every attempt, in order, when the request failed over at least once; otherwise null. */
  failoverAttempts: Promise<ByokFailoverAttempt[]> | null;
};

function attemptStatus(attempt: SendUpstreamAttemptResult): number {
  return attempt.type === 'invalid-openrouter-model' ? 404 : attempt.response.status;
}

function failedResponse(attempt: SendUpstreamAttemptResult): Response | null {
  if (attempt.type === 'invalid-openrouter-model' || attempt.response.ok) return null;
  return attempt.response;
}

function byokProviderIds(route: GetProviderProviderResult) {
  return route.userByok?.map(byok => byok.providerId) ?? [];
}

/** Reads a bounded error body, giving up on a slow or oversized one. Consumes the response. */
async function readErrorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const timeout = setTimeout(
    () => void reader.cancel().catch(() => {}),
    ERROR_BODY_READ_TIMEOUT_MS
  );
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_ERROR_BODY_CHARS) return null;
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
}

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : undefined;
}

/**
 * The gateway's own `error_type`, or the provider's error code or type, such as OpenAI's
 * `insufficient_quota` or Anthropic's `rate_limit_error`. Messages can echo request content, so
 * only identifier-shaped codes are kept.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await readErrorBody(response);
    if (!isRecord(body)) return undefined;
    const error = isRecord(body.error) ? body.error : {};
    return codeOf(body.error_type) ?? codeOf(error.code) ?? codeOf(error.type) ?? codeOf(body.code);
  } catch {
    return undefined;
  }
}

function remainingBudgetMs(startedAt: number): number {
  // Node's AbortSignal.timeout throws for a fractional delay.
  return Math.floor(UPSTREAM_DURATION_BUDGET_MS - (performance.now() - startedAt));
}

type PendingAttempt = Omit<ByokFailoverAttempt, 'error_code'> & {
  errorCode: Promise<string | undefined>;
};

/**
 * Sends the request through its route and, while a BYOK key's upstream fails with an
 * unsuccessful status, through the owner's next BYOK key. When every key fails, the last
 * failure is returned: failover never reaches Kilo's route or another payer's connection.
 */
export async function sendUpstreamAttemptWithByokFailover(
  input: Omit<SendUpstreamAttemptInput, 'upstreamDurationBudgetMs'>
): Promise<ByokFailoverResult> {
  let providerContext = input.providerContext;
  let request = input.request;
  if (!providerContext.failover) {
    return {
      attempt: await sendUpstreamAttempt({
        ...input,
        upstreamDurationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
      }),
      providerContext,
      request,
      failoverAttempts: null,
    };
  }

  // Provider transforms mutate the request they send, so each failover sends a copy of the original.
  const original = structuredClone(request);
  const startedAt = performance.now();
  // Error codes are read off the request path, so reading a slow error body never delays failover
  // or the response.
  const pending: PendingAttempt[] = [];
  let attemptStartedAt = startedAt;
  let attempt = await sendUpstreamAttempt({
    ...input,
    upstreamDurationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });
  let attemptDurationMs = Math.round(performance.now() - attemptStartedAt);
  let stopReason: ByokFailoverAttempt['stop_reason'];
  for (;;) {
    if (attempt.type === 'invalid-openrouter-model') {
      stopReason = 'model-unavailable';
      break;
    }
    const failed = failedResponse(attempt);
    if (!failed) break;
    if (input.signal?.aborted) {
      stopReason = 'client-disconnected';
      break;
    }
    // All attempts share one upstream budget, so the invocation still ends within the route's
    // maxDuration with time left for usage accounting.
    if (remainingBudgetMs(startedAt) < MIN_FAILOVER_BUDGET_MS) {
      stopReason = 'budget-exhausted';
      break;
    }
    const next = providerContext.failover ? await providerContext.failover() : null;
    if (!next) {
      stopReason = 'no-keys-left';
      break;
    }
    const budgetMs = remainingBudgetMs(startedAt);
    if (budgetMs < MIN_FAILOVER_BUDGET_MS) {
      stopReason = 'budget-exhausted';
      break;
    }
    console.warn('[byok-failover] BYOK upstream failed, trying the next BYOK key', {
      status: failed.status,
      failedProviderIds: byokProviderIds(providerContext),
      nextProviderIds: byokProviderIds(next),
    });
    pending.push({
      provider_type: providerContext.provider.type,
      byok_provider_ids: byokProviderIds(providerContext),
      status: failed.status,
      errorCode: readErrorCode(failed),
      duration_ms: attemptDurationMs,
      outcome: 'failed-over',
    });
    providerContext = next;
    request = structuredClone(original);
    attemptStartedAt = performance.now();
    attempt = await sendUpstreamAttempt({
      ...input,
      providerContext,
      request,
      upstreamDurationBudgetMs: budgetMs,
    });
    attemptDurationMs = Math.round(performance.now() - attemptStartedAt);
  }

  if (pending.length === 0) {
    return { attempt, providerContext, request, failoverAttempts: null };
  }
  const failed = failedResponse(attempt);
  pending.push({
    provider_type: providerContext.provider.type,
    byok_provider_ids: byokProviderIds(providerContext),
    status: attemptStatus(attempt),
    // The client still reads the failure, so the code comes from a copy.
    errorCode: failed ? readErrorCode(failed.clone()) : Promise.resolve(undefined),
    duration_ms: attemptDurationMs,
    ...(failed || attempt.type === 'invalid-openrouter-model'
      ? { outcome: 'failed' as const, stop_reason: stopReason ?? 'no-keys-left' }
      : { outcome: 'served' as const }),
  });
  const failoverAttempts = Promise.all(
    pending.map(async ({ errorCode, ...rest }) => {
      const error_code = await errorCode;
      return error_code ? { ...rest, error_code } : rest;
    })
  );
  return { attempt, providerContext, request, failoverAttempts };
}
