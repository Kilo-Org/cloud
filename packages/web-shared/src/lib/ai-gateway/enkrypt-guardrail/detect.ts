import * as z from 'zod';
import type {
  EnkryptDetectorId,
  EnkryptGuardrailApiKind,
  EnkryptGuardrailDecision,
} from '@kilocode/db/schema-types';
import type { EnkryptGuardrailCall } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  ENKRYPT_DETECTOR_TYPES,
  ENKRYPT_SUMMARY_DETECTORS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { MAX_ENKRYPT_CREDITS_PER_CALL } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

type ReadyEnkryptInputGuardrailConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

export const ENKRYPT_DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';

/**
 * Bounds every attempt of a scan together. The gateway awaits a blocking scan just before the
 * upstream request, so this is the most latency an enabled organization's request can gain. It also
 * bounds the deferred work of a log-only scan, which the request does not wait for.
 */
export const ENKRYPT_GUARDRAIL_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 2;

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

export type EnkryptGuardrailScan = {
  sessionId: string | null;
  organizationId: string;
  kiloUserId: string;
  apiKind: EnkryptGuardrailApiKind;
  clientRequestId: string | null;
  text: string;
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
};

export type EnkryptDetectDependencies = {
  apiKey: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
  signal: AbortSignal;
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

async function detectOnce(
  body: string,
  signal: AbortSignal,
  deps: EnkryptDetectDependencies & { apiKey: string }
): Promise<DetectAttempt> {
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
    return aborted
      ? { kind: 'failed', error: aborted, retryable: false, creditsCost: null }
      : { kind: 'failed', error: 'network', retryable: true, creditsCost: null };
  }
  const creditsCost = parseCreditsCost(response);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return {
      kind: 'failed',
      error: `http_${response.status}`,
      // An immediate retry of a 429 would hit the same limiter within the deadline.
      retryable: response.status >= 500,
      creditsCost,
    };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      kind: 'failed',
      error: abortError(signal, deps) ?? 'invalid_response',
      retryable: false,
      creditsCost,
    };
  }
  const parsed = detectResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'failed', error: 'invalid_response', retryable: false, creditsCost };
  }
  const erroredDetectors = matchingDetectors(parsed.data.summary, hasErrored);
  if (erroredDetectors.length > 0) {
    return {
      kind: 'failed',
      error: `detector_error:${erroredDetectors.join(',')}`,
      // The known cause is deterministic, so an immediate retry would fail again and be charged again.
      retryable: false,
      creditsCost,
    };
  }
  return {
    kind: 'detected',
    firedDetectors: matchingDetectors(parsed.data.summary, hasFired),
    resultMessage: parsed.data.result_message ?? null,
    creditsCost,
  };
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
    (enkryptBlocked ? sanitizeBlockMessage(resultMessage) : null) ??
    'The request was flagged by your organization policy. Review it and retry.';
  return `Your organization's Enkrypt AI guardrail blocked this request (detected: ${detectors.join(', ')}). ${reason}`;
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
  const { text, config } = scan;
  if (text.length === 0) return { verdict: { action: 'allow' }, usageRecords: [] };

  const kind = scanKind(config);
  const baseLogFields = {
    scan: kind,
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
    scan_tool_results: config.scanToolResults,
    scanned_characters: text.length,
  };

  if (config.status === 'invalid') {
    return failedVerdict([], baseLogFields, { scan: kind, error: 'invalid_config', latencyMs: 0 });
  }

  const logFields = {
    ...baseLogFields,
    detectors_enabled: Object.keys(config.detectors),
    detectors_blocking: config.blockingDetectors,
  };

  if (deps.signal.aborted) {
    return failedVerdict([], logFields, { scan: kind, error: 'client_aborted', latencyMs: 0 });
  }

  if (text.length > ENKRYPT_MAX_SCAN_CHARACTERS) {
    return failedVerdict([], logFields, {
      scan: kind,
      error: 'request_too_large',
      latencyMs: 0,
      closedVerdict: { action: 'block', message: REQUEST_TOO_LARGE_MESSAGE },
    });
  }

  const apiKey = deps.apiKey;
  if (!apiKey) {
    return failedVerdict([], logFields, { scan: kind, error: 'missing_api_key', latencyMs: 0 });
  }

  const body = JSON.stringify({
    text,
    detectors: config.detectors,
    user_metadata: { organization_id: scan.organizationId },
  });
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs)]);
  const startedAt = performance.now();
  const attempts: DetectAttempt[] = [];
  let attempt: DetectAttempt;
  do {
    attempt = await detectOnce(body, signal, { ...deps, apiKey });
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
    apiKind: scan.apiKind,
    decision: attemptDecision(each, config),
    creditsCost: each.creditsCost,
  }));

  if (attempt.kind === 'failed') {
    return failedVerdict(usageRecords, logFields, { scan: kind, error: attempt.error, latencyMs });
  }

  const blocking = blockingDetectors(attempt.firedDetectors, config);
  const decided = {
    ...logFields,
    detectors_fired: attempt.firedDetectors,
    latency_ms: latencyMs,
    attempts: attempts.length,
    credits_cost: totalCredits(usageRecords),
  };
  if (blocking.length === 0) {
    console.debug('[enkrypt-guardrail] decision', { ...decided, decision: 'allowed' });
    return { verdict: { action: 'allow' }, usageRecords };
  }
  console.debug('[enkrypt-guardrail] decision', { ...decided, decision: 'blocked' });
  return {
    verdict: { action: 'block', message: guardrailBlockMessage(blocking, attempt.resultMessage) },
    usageRecords,
  };
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

function failureDecision(failure: { scan: EnkryptScanKind; error: ScanError }) {
  if (failure.error === 'client_aborted') return 'client_aborted';
  return failure.scan === 'log_only' ? 'error_logged' : 'error_fail_closed';
}

function failureVerdict(failure: {
  scan: EnkryptScanKind;
  error: ScanError;
  closedVerdict?: EnkryptGuardrailVerdict;
}): EnkryptGuardrailVerdict {
  if (failure.scan === 'log_only') return { action: 'allow' };
  return (
    failure.closedVerdict ?? { action: 'unavailable', reason: unavailableReason(failure.error) }
  );
}

/**
 * A client disconnect is not an Enkrypt failure: it is logged at debug level, and only calls that
 * reported a cost are charged, so cancelled requests do not inflate the guardrail error rate.
 */
function failedVerdict(
  usageRecords: EnkryptGuardrailCall[],
  logFields: Record<string, unknown>,
  failure: {
    scan: EnkryptScanKind;
    error: ScanError;
    latencyMs: number;
    closedVerdict?: EnkryptGuardrailVerdict;
  }
): EnkryptGuardrailScanResult {
  const clientAborted = failure.error === 'client_aborted';
  const recordedUsageRecords = clientAborted
    ? usageRecords.filter(usageRecord => usageRecord.creditsCost !== null)
    : usageRecords;
  const fields = {
    ...logFields,
    decision: failureDecision(failure),
    error: failure.error,
    latency_ms: failure.latencyMs,
    attempts: usageRecords.length,
    credits_cost: totalCredits(usageRecords),
  };
  if (clientAborted) console.debug('[enkrypt-guardrail] decision', fields);
  else warnExceptInTest('[enkrypt-guardrail] decision', fields);
  return { verdict: failureVerdict(failure), usageRecords: recordedUsageRecords };
}
