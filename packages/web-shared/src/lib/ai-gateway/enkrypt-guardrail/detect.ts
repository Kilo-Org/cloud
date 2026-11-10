import * as z from 'zod';
import {
  ENKRYPT_DETECTOR_IDS,
  type EnkryptDetectorId,
  type EnkryptGuardrailApiKind,
  type EnkryptGuardrailDecision,
} from '@kilocode/db/schema-types';
import type { EnkryptGuardrailCall } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  ENKRYPT_DETECTOR_TYPES,
  ENKRYPT_SUMMARY_DETECTORS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type { EnkryptScanReport } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { MAX_ENKRYPT_CREDITS_PER_CALL } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { EnkryptRequestLog } from '@kilocode/web-shared/lib/r2/api-request-log';

type ReadyEnkryptInputGuardrailConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

export const ENKRYPT_DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';

/**
 * Bounds every attempt of a scan together. The gateway awaits a blocking scan just before the
 * upstream request, so this is the most latency an enabled organization's request can gain. It also
 * bounds the deferred work of a log-only scan, which the request does not wait for.
 */
export const ENKRYPT_GUARDRAIL_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 2;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 1_000;

/**
 * A larger request is not sent to Enkrypt. It is never truncated: the model would still read the
 * unscanned remainder, which is where an injected instruction in a large file read would sit.
 * The limit is about 1M tokens of code, which tokenizes at roughly 3 characters per token.
 */
export const ENKRYPT_MAX_SCAN_CHARACTERS = 3_000_000;

const MAX_BLOCK_MESSAGE_LENGTH = 500;

const REQUEST_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot scan more than ${ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US')} characters of conversation text at once, so this request was not sent. Compact or prune earlier conversation history, reduce tool output or tool definitions, or start a new session, then retry. Retrying the unchanged request will not help.`;

const detectResponseSchema = z.object({
  summary: z.record(z.string(), z.unknown()),
  result_message: z.string().nullish(),
});

/**
 * How much of the request `text` covers. With a cached prefix, `text` is only the uncached suffix
 * plus an overlap of already-scanned text.
 */
export type EnkryptScanCoverage = {
  cache: 'off' | 'miss' | 'hit' | 'error';
  totalCharacters: number;
  totalSegments: number;
  cachedCharacters: number;
  cachedSegments: number;
};

export type EnkryptGuardrailScan = {
  sessionId: string | null;
  microdollarUsageId?: string;
  organizationId: string;
  kiloUserId: string;
  apiKind: EnkryptGuardrailApiKind;
  clientRequestId: string | null;
  text: string;
  coverage: EnkryptScanCoverage;
  config: EnkryptInputGuardrailConfig;
};

/**
 * `skip`: no scan gates the request, because the organization has no guardrail or its detectors
 * only log. An unavailable guardrail's `reason` is `transient` when an automatic retry could
 * succeed, and `timeout` when the scan ran out of time, which a long conversation makes likely to
 * recur.
 */
export type EnkryptGuardrailVerdict =
  | { action: 'skip' }
  | { action: 'allow' }
  | { action: 'block'; message: string }
  | { action: 'unavailable'; reason: EnkryptUnavailableReason };

export type EnkryptUnavailableReason = 'transient' | 'timeout' | 'failed';

/**
 * A `log_only` scan has no detector that can block, so the request does not wait for it and its
 * failures are only logged: the request is never rejected because of it.
 */
type EnkryptScanKind = 'blocking' | 'log_only';

function scanKind(config: EnkryptInputGuardrailConfig): EnkryptScanKind {
  return config.status === 'ready' && config.blockingDetectors.length === 0
    ? 'log_only'
    : 'blocking';
}

export type EnkryptGuardrailScanResult = {
  verdict: EnkryptGuardrailVerdict;
  usageRecords: EnkryptGuardrailCall[];
  report: EnkryptScanReport;
};

export type EnkryptDetectDependencies = {
  apiKey: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
  signal: AbortSignal;
  requestLog?: {
    guardrail: EnkryptRequestLog['guardrail'];
    capture: (entry: Promise<EnkryptRequestLog>) => void;
    captureResponse?: Promise<boolean>;
  };
};

type DetectError =
  | 'client_aborted'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | `http_${number}`
  | `detector_error:${string}`;

type ScanError = DetectError | 'invalid_config' | 'missing_api_key' | 'request_too_large';

type DetectAttempt =
  | {
      kind: 'detected';
      firedDetectors: EnkryptDetectorId[];
      resultMessage: string | null;
      creditsCost: number | null;
    }
  | { kind: 'failed'; error: DetectError; retryable: boolean; creditsCost: number | null };

function hasFired(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
}

/**
 * A detector that fails inside Enkrypt, for example on a very large policy rule set, still gets an
 * HTTP 200 response, with -1 as its summary value.
 */
function hasErrored(value: unknown): boolean {
  return typeof value === 'number' && value < 0;
}

function matchingDetectors(
  summary: Record<string, unknown>,
  matches: (value: unknown) => boolean
): EnkryptDetectorId[] {
  return Object.entries(summary).flatMap(([name, value]) => {
    const detector = Object.hasOwn(ENKRYPT_SUMMARY_DETECTORS, name)
      ? ENKRYPT_SUMMARY_DETECTORS[name]
      : undefined;
    return detector && matches(value) ? [detector] : [];
  });
}

/** Detections block only when the organization configured the detector to block. */
function blockingDetectors(
  fired: EnkryptDetectorId[],
  config: ReadyEnkryptInputGuardrailConfig
): EnkryptDetectorId[] {
  return fired.filter(detector => config.blockingDetectors.includes(detector));
}

function parseCreditsCost(response: Response): number | null {
  const header = response.headers.get('x-enkrypt-credits-cost');
  if (header === null || header.trim() === '') return null;
  const value = Number(header);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > MAX_ENKRYPT_CREDITS_PER_CALL) {
    warnExceptInTest('[enkrypt-guardrail] credits cost above the per-call maximum; clamped', {
      credits_cost: value,
      max_credits: MAX_ENKRYPT_CREDITS_PER_CALL,
    });
    return MAX_ENKRYPT_CREDITS_PER_CALL;
  }
  return value;
}

/** The scan signal combines the client's disconnect signal with the shared deadline. */
function abortError(signal: AbortSignal, deps: EnkryptDetectDependencies): DetectError | null {
  if (deps.signal.aborted) return 'client_aborted';
  return signal.aborted ? 'timeout' : null;
}

async function captureErrorBody(
  response: Response,
  requestLog: EnkryptRequestLog,
  signal: AbortSignal,
  captureResponse: Promise<boolean> = Promise.resolve(true)
): Promise<void> {
  const aborted = Promise.withResolvers<boolean>();
  const onAbort = () => aborted.resolve(false);
  signal.addEventListener('abort', onAbort, { once: true });
  let shouldCapture: boolean;
  try {
    shouldCapture = !signal.aborted && (await Promise.race([captureResponse, aborted.promise]));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (!shouldCapture) {
    if (signal.aborted) requestLog.response_truncated = true;
    void response.body?.cancel().catch(() => {});
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  const timeout = setTimeout(() => {
    requestLog.response_truncated = true;
    void reader.cancel().catch(() => {});
  }, ERROR_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, MAX_ERROR_BODY_BYTES - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) {
        requestLog.response_truncated = true;
        break;
      }
    }
  } catch {
    requestLog.response_truncated = true;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    requestLog.response = text + decoder.decode();
  }
}

async function detectOnce(
  body: string,
  signal: AbortSignal,
  deps: EnkryptDetectDependencies & { apiKey: string },
  requestLog: EnkryptRequestLog | undefined
): Promise<DetectAttempt> {
  const finish = (attempt: DetectAttempt): DetectAttempt => {
    if (requestLog) {
      requestLog.error = attempt.kind === 'failed' ? attempt.error : null;
      deps.requestLog?.capture(capturedBody.then(() => requestLog));
    }
    return attempt;
  };
  let capturedBody = Promise.resolve();
  let response: Response;
  try {
    response = await deps.fetch(ENKRYPT_DETECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: deps.apiKey },
      body,
      signal,
    });
  } catch {
    const aborted = abortError(signal, deps);
    return finish(
      aborted
        ? { kind: 'failed', error: aborted, retryable: false, creditsCost: null }
        : { kind: 'failed', error: 'network', retryable: true, creditsCost: null }
    );
  }
  if (requestLog) requestLog.status_code = response.status;
  const creditsCost = parseCreditsCost(response);
  if (!response.ok) {
    if (requestLog) {
      capturedBody = captureErrorBody(
        response,
        requestLog,
        signal,
        deps.requestLog?.captureResponse
      );
    } else {
      await response.body?.cancel().catch(() => {});
    }
    return finish({
      kind: 'failed',
      error: `http_${response.status}`,
      // An immediate retry of a 429 would hit the same limiter within the deadline.
      retryable: response.status >= 500,
      creditsCost,
    });
  }
  let json: unknown;
  try {
    const text = await response.text();
    if (requestLog) requestLog.response = text;
    json = JSON.parse(text);
  } catch {
    return finish({
      kind: 'failed',
      error: abortError(signal, deps) ?? 'invalid_response',
      retryable: false,
      creditsCost,
    });
  }
  const parsed = detectResponseSchema.safeParse(json);
  if (!parsed.success) {
    return finish({ kind: 'failed', error: 'invalid_response', retryable: false, creditsCost });
  }
  const erroredDetectors = matchingDetectors(parsed.data.summary, hasErrored);
  if (erroredDetectors.length > 0) {
    return finish({
      kind: 'failed',
      error: `detector_error:${erroredDetectors.join(',')}`,
      // The known cause is deterministic, so an immediate retry would fail again and be charged again.
      retryable: false,
      creditsCost,
    });
  }
  return finish({
    kind: 'detected',
    firedDetectors: matchingDetectors(parsed.data.summary, hasFired),
    resultMessage: parsed.data.result_message ?? null,
    creditsCost,
  });
}

function sanitizeBlockMessage(message: string | null): string | null {
  const cleaned = message
    ?.replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, MAX_BLOCK_MESSAGE_LENGTH);
  return cleaned || null;
}

/**
 * Enkrypt's `result_message` is a block message only when a block-type detector fired; when only
 * revise-type detectors fired it is the redacted input text, which is never shown.
 */
export function guardrailBlockMessage(
  detectors: EnkryptDetectorId[],
  resultMessage: string | null
): string {
  const enkryptBlocked = detectors.some(detector => ENKRYPT_DETECTOR_TYPES[detector] === 'block');
  const reason =
    (enkryptBlocked ? sanitizeBlockMessage(resultMessage) : null) ?? REQUEST_FLAGGED_REASON;
  return `${REQUEST_BLOCKED} (detected: ${detectors.join(', ')}). ${reason}`;
}

const REQUEST_BLOCKED = "Your organization's Enkrypt AI guardrail blocked this request";
const REQUEST_FLAGGED_REASON = 'The request was flagged by your organization policy.';
const RESPONSE_BLOCKED = "Your organization's Enkrypt AI guardrail blocked the model's response";
const RESPONSE_FLAGGED_REASON =
  'The response was flagged by your organization policy. Rephrase the request and retry.';

/**
 * `scanRequest` words a block for a request; the output guardrail scans the model's response with
 * it and rewords the block for the response.
 */
export function responseBlockMessage(requestBlockMessage: string): string {
  return requestBlockMessage
    .replace(REQUEST_BLOCKED, RESPONSE_BLOCKED)
    .replace(REQUEST_FLAGGED_REASON, RESPONSE_FLAGGED_REASON);
}

function attemptDecision(
  attempt: DetectAttempt,
  config: ReadyEnkryptInputGuardrailConfig
): EnkryptGuardrailDecision {
  if (attempt.kind === 'failed') return 'error';
  return blockingDetectors(attempt.firedDetectors, config).length > 0 ? 'blocked' : 'allowed';
}

/**
 * Scans the request once, retrying a single transient failure within the shared deadline, and
 * maps the result to a verdict. Never throws. Returns one usage record per Enkrypt call, including
 * calls that failed, so a blocked or failed request is still accounted for. Any failure of a
 * blocking scan rejects the request, so a request never reaches the model unchecked by a detector
 * that can block it. A log-only scan always allows.
 */
export async function scanRequest(
  scan: EnkryptGuardrailScan,
  deps: EnkryptDetectDependencies
): Promise<EnkryptGuardrailScanResult> {
  const { text, config, coverage } = scan;
  const kind = scanKind(config);
  const scope: ScanScope = {
    kind,
    logFields: {
      organization_id: scan.organizationId,
      session_id: scan.sessionId,
      client_request_id: scan.clientRequestId,
      api_kind: scan.apiKind,
      scan_tool_results: config.scanToolResults,
    },
    report: {
      scan: kind,
      detectors_enabled: config.status === 'ready' ? enabledDetectors(config) : [],
      detectors_blocking: config.status === 'ready' ? config.blockingDetectors : [],
      verdict_cache: coverage.cache,
      total_characters: coverage.totalCharacters,
      total_segments: coverage.totalSegments,
      cached_characters: coverage.cachedCharacters,
      cached_segments: coverage.cachedSegments,
      scanned_characters: text.length,
    },
  };

  if (text.length === 0) {
    const report = scanReport(scope, { decision: 'allowed', latencyMs: 0 });
    if (coverage.cachedSegments > 0) logDecision(scope, report);
    return { verdict: { action: 'allow' }, usageRecords: [], report };
  }

  if (config.status === 'invalid') {
    return failedVerdict([], scope, { error: 'invalid_config', latencyMs: 0 });
  }

  if (deps.signal.aborted) {
    return failedVerdict([], scope, { error: 'client_aborted', latencyMs: 0 });
  }

  if (text.length > ENKRYPT_MAX_SCAN_CHARACTERS) {
    return failedVerdict([], scope, {
      error: 'request_too_large',
      latencyMs: 0,
      closedVerdict: { action: 'block', message: REQUEST_TOO_LARGE_MESSAGE },
    });
  }

  const apiKey = deps.apiKey;
  if (!apiKey) {
    return failedVerdict([], scope, { error: 'missing_api_key', latencyMs: 0 });
  }

  const request = {
    text,
    detectors: config.detectors,
    user_metadata: { organization_id: scan.organizationId },
  };
  const body = JSON.stringify(request);
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs)]);
  const startedAt = performance.now();
  const attempts: DetectAttempt[] = [];
  let attempt: DetectAttempt;
  do {
    const requestLog: EnkryptRequestLog | undefined = deps.requestLog
      ? {
          guardrail: deps.requestLog.guardrail,
          scan: kind,
          request,
          response: null,
          status_code: null,
          error: null,
        }
      : undefined;
    attempt = await detectOnce(body, signal, { ...deps, apiKey }, requestLog);
    attempts.push(attempt);
  } while (
    attempt.kind === 'failed' &&
    attempt.retryable &&
    attempts.length < MAX_ATTEMPTS &&
    !signal.aborted
  );
  const latencyMs = Math.round(performance.now() - startedAt);

  const usageRecords = attempts.map((each): EnkryptGuardrailCall => ({
    organizationId: scan.organizationId,
    kiloUserId: scan.kiloUserId,
    sessionId: scan.sessionId,
    microdollarUsageId: scan.microdollarUsageId,
    apiKind: scan.apiKind,
    decision: attemptDecision(each, config),
    creditsCost: each.creditsCost,
    ...(each.kind === 'detected' && each.firedDetectors.length > 0
      ? { detectorsFired: each.firedDetectors }
      : {}),
  }));

  if (attempt.kind === 'failed') {
    return failedVerdict(usageRecords, scope, { error: attempt.error, latencyMs });
  }

  const blocking = blockingDetectors(attempt.firedDetectors, config);
  const report = scanReport(scope, {
    decision: blocking.length === 0 ? 'allowed' : 'blocked',
    detectorsFired: attempt.firedDetectors,
    usageRecords,
    latencyMs,
  });
  logDecision(scope, report);
  return {
    verdict:
      blocking.length === 0
        ? { action: 'allow' }
        : { action: 'block', message: guardrailBlockMessage(blocking, attempt.resultMessage) },
    usageRecords,
    report,
  };
}

type ScanScope = {
  kind: EnkryptScanKind;
  logFields: Record<string, unknown>;
  report: Pick<
    EnkryptScanReport,
    | 'scan'
    | 'detectors_enabled'
    | 'detectors_blocking'
    | 'verdict_cache'
    | 'total_characters'
    | 'total_segments'
    | 'cached_characters'
    | 'cached_segments'
    | 'scanned_characters'
  >;
};

function enabledDetectors(config: ReadyEnkryptInputGuardrailConfig): EnkryptDetectorId[] {
  return ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined);
}

function scanReport(
  scope: ScanScope,
  outcome: {
    decision: EnkryptScanReport['decision'];
    error?: ScanError;
    detectorsFired?: EnkryptDetectorId[];
    usageRecords?: EnkryptGuardrailCall[];
    latencyMs: number;
  }
): EnkryptScanReport {
  const usageRecords = outcome.usageRecords ?? [];
  return {
    ...scope.report,
    decision: outcome.decision,
    error: outcome.error ?? null,
    detectors_fired: outcome.detectorsFired ?? [],
    attempts: usageRecords.length,
    credits_cost: totalCredits(usageRecords),
    latency_ms: outcome.latencyMs,
  };
}

/** A client disconnect is not an Enkrypt failure, so it is logged at debug level. */
function logDecision(scope: ScanScope, report: EnkryptScanReport): void {
  const fields = { ...scope.logFields, ...report };
  const failed = report.error !== null && report.decision !== 'client_aborted';
  if (failed) warnExceptInTest('[enkrypt-guardrail] decision', fields);
  else console.debug('[enkrypt-guardrail] decision', fields);
}

function totalCredits(usageRecords: EnkryptGuardrailCall[]): number | null {
  const costs = usageRecords.flatMap(usageRecord =>
    usageRecord.creditsCost === null ? [] : [usageRecord.creditsCost]
  );
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

function unavailableReason(error: ScanError): EnkryptUnavailableReason {
  if (error === 'timeout') return 'timeout';
  const transient = error === 'network' || error === 'http_429' || /^http_5\d\d$/.test(error);
  return transient ? 'transient' : 'failed';
}

function failureDecision(kind: EnkryptScanKind, error: ScanError): EnkryptScanReport['decision'] {
  if (error === 'client_aborted') return 'client_aborted';
  return kind === 'log_only' ? 'error_logged' : 'error_fail_closed';
}

function failureVerdict(
  kind: EnkryptScanKind,
  failure: { error: ScanError; closedVerdict?: EnkryptGuardrailVerdict }
): EnkryptGuardrailVerdict {
  if (kind === 'log_only') return { action: 'allow' };
  return (
    failure.closedVerdict ?? { action: 'unavailable', reason: unavailableReason(failure.error) }
  );
}

/**
 * Only calls that reported a cost are charged for a client disconnect, so cancelled requests do not
 * inflate the guardrail error rate.
 */
function failedVerdict(
  usageRecords: EnkryptGuardrailCall[],
  scope: ScanScope,
  failure: {
    error: ScanError;
    latencyMs: number;
    closedVerdict?: EnkryptGuardrailVerdict;
  }
): EnkryptGuardrailScanResult {
  const report = scanReport(scope, {
    decision: failureDecision(scope.kind, failure.error),
    error: failure.error,
    usageRecords,
    latencyMs: failure.latencyMs,
  });
  logDecision(scope, report);
  return {
    verdict: failureVerdict(scope.kind, failure),
    usageRecords:
      failure.error === 'client_aborted'
        ? usageRecords.filter(usageRecord => usageRecord.creditsCost !== null)
        : usageRecords,
    report,
  };
}
