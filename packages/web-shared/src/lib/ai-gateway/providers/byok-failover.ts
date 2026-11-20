import type { ProviderRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type {
  ByokFailoverAttempt,
  FailoverErrorSummary,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
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
const MAX_SUMMARY_ISSUES = 5;
const MAX_SUMMARY_FIELD_CHARS = 200;
const SUMMARY_TYPE_PATTERN = /^[\w.:-]+$/;
const SUMMARY_LOC_PATTERN = /^[\w.:[\]-]+$/;

type ByokFailoverResult = {
  attempt: SendUpstreamAttemptResult;
  /** The route that sent the returned attempt. */
  providerContext: ProviderRoute;
  /** The request as sent for the returned attempt. */
  request: GatewayRequest;
  /** Every attempt, in order, when the request failed over at least once; otherwise null. */
  failoverAttempts: Promise<ByokFailoverAttempt[]> | null;
};

function attemptStatus(attempt: SendUpstreamAttemptResult): number {
  return attempt.type === 'unknown-gateway-model' ? 404 : attempt.response.status;
}

function failedResponse(attempt: SendUpstreamAttemptResult): Response | null {
  if (attempt.type === 'unknown-gateway-model' || attempt.response.ok) return null;
  return attempt.response;
}

function byokProviderIds(route: ProviderRoute) {
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

function boundedField(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = value.slice(0, MAX_SUMMARY_FIELD_CHARS);
  return pattern.test(bounded) ? bounded : undefined;
}

function summaryCode(value: unknown): string | undefined {
  return codeOf(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
}

function locOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.slice(0, 32).filter(s => typeof s === 'string' || typeof s === 'number');
  return boundedField(segments.join('.'), SUMMARY_LOC_PATTERN);
}

/** The validation error list of a strict upstream: Mistral nests it in `message.detail`, FastAPI
 * style upstreams put `detail` at the top level. */
function validationIssuesOf(body: Record<string, unknown>, error: Record<string, unknown>) {
  const message = isRecord(body.message) ? body.message : {};
  const list = [body.detail, message.detail, error.detail].find(Array.isArray);
  const issues: NonNullable<FailoverErrorSummary['issues']> = [];
  for (const entry of list ?? []) {
    if (issues.length >= MAX_SUMMARY_ISSUES) break;
    if (!isRecord(entry)) continue;
    const type = boundedField(entry.type, SUMMARY_TYPE_PATTERN);
    const loc = locOf(entry.loc);
    if (type || loc) issues.push({ ...(type ? { type } : {}), ...(loc ? { loc } : {}) });
  }
  return issues;
}

/**
 * Only error type strings, field paths, and identifier-shaped codes. The `msg`, `input`, and free
 * text `message` of an error echo request content, so they are never read.
 */
function summarizeError(body: unknown): FailoverErrorSummary | undefined {
  if (!isRecord(body)) return undefined;
  const error = isRecord(body.error) ? body.error : {};
  const code = summaryCode(error.code) ?? summaryCode(body.code);
  const type = boundedField(error.type ?? body.type, SUMMARY_TYPE_PATTERN);
  const issues = validationIssuesOf(body, error);
  if (!code && !type && issues.length === 0) return undefined;
  return {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

type ErrorDetails = { errorCode?: string; errorSummary?: FailoverErrorSummary };

/**
 * The gateway's own `error_type`, or the provider's error code or type, such as OpenAI's
 * `insufficient_quota` or Anthropic's `rate_limit_error`. Messages can echo request content, so
 * only identifier-shaped codes are kept. A route that reports a summary also gets the allowlisted
 * summary of its 4xx failure.
 */
async function readErrorDetails(response: Response, withSummary: boolean): Promise<ErrorDetails> {
  try {
    const body = await readErrorBody(response);
    if (!isRecord(body)) return {};
    const error = isRecord(body.error) ? body.error : {};
    const errorCode =
      codeOf(body.error_type) ?? codeOf(error.code) ?? codeOf(error.type) ?? codeOf(body.code);
    const errorSummary =
      withSummary && response.status >= 400 && response.status < 500
        ? summarizeError(body)
        : undefined;
    return { errorCode, errorSummary };
  } catch {
    return {};
  }
}

/** Resolves a later route of the request, or null when it cannot serve it, such as a key the
 * organization policy refuses. */
export type FailoverRoute = () => Promise<ProviderRoute | null>;

async function firstUsable(routes: Iterator<FailoverRoute>): Promise<ProviderRoute | null> {
  for (let next = routes.next(); !next.done; next = routes.next()) {
    const route = await next.value();
    if (route) return route;
  }
  return null;
}

function remainingBudgetMs(startedAt: number): number {
  // Node's AbortSignal.timeout throws for a fractional delay.
  return Math.floor(UPSTREAM_DURATION_BUDGET_MS - (performance.now() - startedAt));
}

type PendingAttempt = Omit<ByokFailoverAttempt, 'error_code' | 'error_summary'> & {
  details: Promise<ErrorDetails>;
};

/** Reads the failure off the request path. A custom LLM route's summary is also logged, once read,
 * because the failover warning cannot wait for the body. */
function readFailureDetails(route: ProviderRoute, failed: Response): Promise<ErrorDetails> {
  const isCustomLlm = !!route.customLlmPublicId;
  const details = readErrorDetails(failed, isCustomLlm);
  if (isCustomLlm) {
    void details.then(({ errorSummary }) => {
      if (!errorSummary) return;
      console.warn('[byok-failover] Custom LLM upstream rejected the request', {
        customLlmPublicId: route.customLlmPublicId,
        status: failed.status,
        errorSummary,
      });
    });
  }
  return details;
}

/**
 * Sends the request through its first route and, while a route's upstream fails with an
 * unsuccessful status, through the next of `failoverRoutes`. When every route fails, the last
 * failure is returned. `getProvider` lists only the owner's BYOK keys after a BYOK key, so
 * failover never reaches Kilo's route or another payer's connection from one. A partner route
 * fails over to Kilo's gateway route, which Kilo pays for as well.
 */
export async function sendUpstreamAttemptWithByokFailover(
  input: Omit<SendUpstreamAttemptInput, 'upstreamDurationBudgetMs'>,
  failoverRoutes: readonly FailoverRoute[]
): Promise<ByokFailoverResult> {
  let providerContext = input.providerContext;
  let request = input.request;
  if (failoverRoutes.length === 0) {
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
  const remainingRoutes = failoverRoutes.values();
  let attemptStartedAt = startedAt;
  let attempt = await sendUpstreamAttempt({
    ...input,
    upstreamDurationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });
  let attemptDurationMs = Math.round(performance.now() - attemptStartedAt);
  let stopReason: ByokFailoverAttempt['stop_reason'];
  for (;;) {
    if (attempt.type === 'unknown-gateway-model') {
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
    const next = await firstUsable(remainingRoutes);
    if (!next) {
      stopReason = 'no-keys-left';
      break;
    }
    const budgetMs = remainingBudgetMs(startedAt);
    if (budgetMs < MIN_FAILOVER_BUDGET_MS) {
      stopReason = 'budget-exhausted';
      break;
    }
    console.warn('[byok-failover] Upstream failed, trying the next route', {
      failedProviderType: providerContext.provider.type,
      nextProviderType: next.provider.type,
      status: failed.status,
      failedProviderIds: byokProviderIds(providerContext),
      nextProviderIds: byokProviderIds(next),
      ...(providerContext.customLlmPublicId
        ? { failedCustomLlmPublicId: providerContext.customLlmPublicId }
        : {}),
    });
    pending.push({
      provider_type: providerContext.provider.type,
      byok_provider_ids: byokProviderIds(providerContext),
      status: failed.status,
      details: readFailureDetails(providerContext, failed),
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
    // The client still reads the failure, so the details come from a copy.
    details: failed ? readFailureDetails(providerContext, failed.clone()) : Promise.resolve({}),
    duration_ms: attemptDurationMs,
    ...(failed || attempt.type === 'unknown-gateway-model'
      ? { outcome: 'failed' as const, stop_reason: stopReason ?? 'no-keys-left' }
      : { outcome: 'served' as const }),
  });
  const failoverAttempts = Promise.all(
    pending.map(async ({ details, ...rest }) => {
      const { errorCode, errorSummary } = await details;
      return {
        ...rest,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(errorSummary ? { error_summary: errorSummary } : {}),
      };
    })
  );
  return { attempt, providerContext, request, failoverAttempts };
}
