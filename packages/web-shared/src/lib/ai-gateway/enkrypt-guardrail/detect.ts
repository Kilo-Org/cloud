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
  enkryptSummaryDetectorId,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type {
  EnkryptScanKind,
  EnkryptScanPart,
  EnkryptScanReport,
  EnkryptUnavailableReason,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { MAX_ENKRYPT_CREDITS_PER_CALL } from '@kilocode/usage-contracts';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { EnkryptRequestLog } from '@kilocode/web-shared/lib/r2/api-request-log';

type ReadyEnkryptGuardrailConfig = Extract<EnkryptGuardrailConfig, { status: 'ready' }>;

export const ENKRYPT_DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';

export { ENKRYPT_GUARDRAIL_TIMEOUT_MS } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 1_000;

/**
 * The most text one Enkrypt call scans. Longer request text is split into several calls; a scan is
 * never truncated, since the model would still read the unscanned remainder, which is where an
 * injected instruction in a large file read would sit.
 */
export const ENKRYPT_MAX_SCAN_CHARACTERS = 100_000;

const MAX_BLOCK_MESSAGE_LENGTH = 500;

const MAX_SCAN_CHARACTERS_LABEL = ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US');

/** Request text is split into scans; only a segment whose header is too long to split is too large. */
export const REQUEST_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail splits long requests into scans of at most ${MAX_SCAN_CHARACTERS_LABEL} characters, but this request has a name or label, such as a tool or file name, too long to split, so it was not sent. Shorten that name, then retry. Retrying the unchanged request will not help.`;

const detectResponseSchema = z.object({
  summary: z.record(z.string(), z.unknown()),
  result_message: z.string().nullish(),
});

/**
 * How much of the part `text` covers. Units (segments, or slices of a segment too long for one
 * call) with a cached verdict are left out, and each of the rest is scanned by its own call;
 * `chunk` locates this call among them. For tool definitions, the
 * totals and cached counts are those of the one tool the call scans.
 */
export type EnkryptScanCoverage = {
  part: EnkryptScanPart;
  cache: EnkryptScanReport['verdict_cache'];
  totalCharacters: number;
  totalSegments: number;
  /** Characters covered by cached verdicts: whole segments, and cached slices of the others. */
  cachedCharacters: number;
  /** Segments whose units all have a cached verdict. */
  cachedSegments: number;
  /** Units: segments, or slices of a segment too long for one call; repeats count each time. */
  totalUnits: number;
  /** Units with a cached verdict. */
  cachedUnits: number;
  /** Attachments, such as images, represented only by an omission marker. */
  omittedAttachments: number;
  chunk?: { index: number; count: number };
};

/** The request a scan belongs to, and the detectors it scans with. */
export type EnkryptScanContext = {
  sessionId: string | null;
  microdollarUsageId?: string;
  organizationId: string;
  kiloUserId: string;
  apiKind: EnkryptGuardrailApiKind;
  clientRequestId: string | null;
  config: EnkryptGuardrailConfig;
};

export type EnkryptGuardrailScan = EnkryptScanContext & {
  text: string;
  coverage: EnkryptScanCoverage;
};

/** The fields that identify a scan's request in logs. */
export function scanLogFields(scan: EnkryptScanContext) {
  return {
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
  };
}

/**
 * `skip`: no scan gates the request, because the organization has no guardrail or its detectors
 * only log. `fail_open`: Enkrypt failed, so the content was let through unscanned; see
 * `failureVerdict`. `unavailable`: the guardrail could not run for a reason of Kilo's own, such as
 * an invalid configuration or a missing API key, so the content was rejected.
 */
export type EnkryptGuardrailVerdict =
  | { action: 'skip' }
  | { action: 'allow' }
  | { action: 'fail_open' }
  | { action: 'block'; message: string }
  | { action: 'unavailable'; reason: EnkryptUnavailableReason };

export function scanKind(config: EnkryptGuardrailConfig): EnkryptScanKind {
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
  /** Starts a deadline of its own when the scan starts, unless `deadline` is given. */
  timeoutMs: number;
  /** A deadline shared with other scans of the request. */
  deadline?: AbortSignal;
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

/**
 * `detected`: Enkrypt answered. Some detectors may still have failed inside Enkrypt; `error` then
 * names them, and the scan fails unless a blocking detector fired anyway.
 */
type DetectAttempt =
  | {
      kind: 'detected';
      firedDetectors: EnkryptDetectorId[];
      resultMessage: string | null;
      creditsCost: number | null;
      error: `detector_error:${string}` | null;
    }
  | { kind: 'failed'; error: DetectError; creditsCost: number | null };

/**
 * A failure of Enkrypt itself, or of reaching it in time, rather than a client disconnect or a
 * fault of Kilo's own. Enkrypt rejecting the API key (401 or 403) is Kilo's fault: a revoked or
 * wrong `ENKRYPT_API_KEY` must not silently turn the guardrail off.
 */
function isEnkryptFailure(error: ScanError): boolean {
  return (
    error !== 'client_aborted' &&
    error !== 'invalid_config' &&
    error !== 'missing_api_key' &&
    error !== 'request_too_large' &&
    error !== 'http_401' &&
    error !== 'http_403'
  );
}

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
    const detector = enkryptSummaryDetectorId(name);
    return detector && matches(value) ? [detector] : [];
  });
}

/** Detections block only when the organization configured the detector to block. */
function blockingDetectors(
  fired: EnkryptDetectorId[],
  config: ReadyEnkryptGuardrailConfig
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

/** Shared deadlines whose timeout a scan already logged as a warning. */
const timeoutsWarned = new WeakSet<AbortSignal>();

/**
 * Whether a scan already warned about the timeout of the shared `deadline`; records that one
 * does now. A scan with a deadline of its own always warns.
 */
function warnedTimeout(deadline: AbortSignal | undefined): boolean {
  if (!deadline) return false;
  const warned = timeoutsWarned.has(deadline);
  timeoutsWarned.add(deadline);
  return warned;
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
      requestLog.error = attempt.error;
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
    return finish({ kind: 'failed', error: aborted ?? 'network', creditsCost: null });
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
    return finish({ kind: 'failed', error: `http_${response.status}`, creditsCost });
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
      creditsCost,
    });
  }
  const parsed = detectResponseSchema.safeParse(json);
  if (!parsed.success) {
    return finish({ kind: 'failed', error: 'invalid_response', creditsCost });
  }
  const erroredDetectors = matchingDetectors(parsed.data.summary, hasErrored);
  return finish({
    kind: 'detected',
    firedDetectors: matchingDetectors(parsed.data.summary, hasFired),
    resultMessage: parsed.data.result_message ?? null,
    creditsCost,
    error: erroredDetectors.length > 0 ? `detector_error:${erroredDetectors.join(',')}` : null,
  });
}

function sanitizeBlockMessage(message: string | null): string | null {
  const cleaned = message
    ?.replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, MAX_BLOCK_MESSAGE_LENGTH);
  return cleaned || null;
}

const REQUEST_BLOCK_WORDING = {
  blocked: "Your organization's Enkrypt AI guardrail blocked this request",
  flaggedReason: 'The request was flagged by your organization policy.',
};

const RESPONSE_BLOCK_WORDING = {
  blocked: "Your organization's Enkrypt AI guardrail blocked the model's response",
  flaggedReason:
    'The response was flagged by your organization policy. Rephrase the request and retry.',
};

/**
 * Enkrypt's `result_message` is a block message only when a block-type detector fired; when only
 * revise-type detectors fired it is the redacted input text, which is never shown. A block of the
 * model's response is worded for the response; every other part is worded for the request.
 */
export function guardrailBlockMessage(
  detectors: EnkryptDetectorId[],
  resultMessage: string | null,
  part?: EnkryptScanPart
): string {
  const wording = part === 'response' ? RESPONSE_BLOCK_WORDING : REQUEST_BLOCK_WORDING;
  const enkryptBlocked = detectors.some(detector => ENKRYPT_DETECTOR_TYPES[detector] === 'block');
  const reason =
    (enkryptBlocked ? sanitizeBlockMessage(resultMessage) : null) ?? wording.flaggedReason;
  return `${wording.blocked} (detected: ${detectors.join(', ')}). ${reason}`;
}

function attemptDecision(
  attempt: DetectAttempt,
  config: ReadyEnkryptGuardrailConfig
): EnkryptGuardrailDecision {
  if (attempt.kind === 'failed') return 'error';
  if (blockingDetectors(attempt.firedDetectors, config).length > 0) return 'blocked';
  return attempt.error ? 'error' : 'allowed';
}

/**
 * Scans the text with one Enkrypt call, without retrying, and maps the result to a verdict. Never
 * throws. Returns a usage record for the call, including a call that failed, so a blocked or failed
 * request is still accounted for. When Enkrypt fails, a blocking scan fails open; see
 * `failureVerdict`. A log-only scan always allows.
 */
export async function scanRequest(
  scan: EnkryptGuardrailScan,
  deps: EnkryptDetectDependencies
): Promise<EnkryptGuardrailScanResult> {
  const { text, config, coverage } = scan;
  const scope: ScanScope = {
    logFields: { ...scanLogFields(scan), ...(coverage.chunk ? { chunk: coverage.chunk } : {}) },
    report: { ...coverageReport(config, coverage), scanned_characters: text.length },
  };
  const kind = scope.report.scan;

  if (text.length === 0) {
    const report = scanReport(scope, { decision: 'allowed', latencyMs: 0 });
    if (coverage.cachedSegments > 0) logDecision(scope, report);
    return { verdict: { action: 'allow' }, usageRecords: [], report };
  }

  if (config.status === 'invalid') {
    return failedVerdict([], noTextSent(scope), { error: 'invalid_config', latencyMs: 0 });
  }

  if (deps.signal.aborted) {
    return failedVerdict([], noTextSent(scope), { error: 'client_aborted', latencyMs: 0 });
  }

  if (text.length > ENKRYPT_MAX_SCAN_CHARACTERS) {
    return failedVerdict([], noTextSent(scope), {
      error: 'request_too_large',
      latencyMs: 0,
      closedVerdict: { action: 'block', message: REQUEST_TOO_LARGE_MESSAGE },
    });
  }

  const apiKey = deps.apiKey;
  if (!apiKey) {
    return failedVerdict([], noTextSent(scope), { error: 'missing_api_key', latencyMs: 0 });
  }

  const request = {
    text,
    detectors: config.detectors,
    user_metadata: { organization_id: scan.organizationId },
  };
  const body = JSON.stringify(request);
  const signal = AbortSignal.any([
    deps.signal,
    deps.deadline ?? AbortSignal.timeout(deps.timeoutMs),
  ]);
  const notStarted = abortError(signal, deps);
  if (notStarted) {
    // Earlier calls of the request used up the shared deadline, so this one is not made, and sends
    // nothing. Once a timeout of the deadline was logged as a warning, the calls after it log at
    // debug level rather than adding a warning for every unit of a long conversation.
    const quiet = notStarted === 'timeout' && warnedTimeout(deps.deadline);
    return failedVerdict([], noTextSent(scope), { error: notStarted, latencyMs: 0, quiet });
  }
  const startedAt = performance.now();
  const requestLog: EnkryptRequestLog | undefined = deps.requestLog
    ? {
        guardrail: deps.requestLog.guardrail,
        scan: kind,
        part: coverage.part,
        ...(coverage.chunk ? { chunk: coverage.chunk } : {}),
        request,
        response: null,
        status_code: null,
        error: null,
      }
    : undefined;
  // A failed call is deliberately not retried, even when the failure looks transient. Retrying
  // within the request multiplies the load on Enkrypt exactly when it is struggling; the failed
  // content fails open instead and is rescanned once its short-lived cached verdict expires.
  const attempt = await detectOnce(body, signal, { ...deps, apiKey }, requestLog);
  const latencyMs = Math.round(performance.now() - startedAt);
  if (attempt.kind === 'failed' && attempt.error === 'timeout') warnedTimeout(deps.deadline);

  const usageRecords: EnkryptGuardrailCall[] = [
    {
      organizationId: scan.organizationId,
      kiloUserId: scan.kiloUserId,
      sessionId: scan.sessionId,
      microdollarUsageId: scan.microdollarUsageId,
      apiKind: scan.apiKind,
      decision: attemptDecision(attempt, config),
      creditsCost: attempt.creditsCost,
      scannedCharacters: text.length,
      totalCharacters: coverage.totalCharacters,
      addedLatencyMs: latencyMs,
      ...(attempt.kind === 'detected' && attempt.firedDetectors.length > 0
        ? { detectorsFired: attempt.firedDetectors }
        : {}),
    },
  ];

  if (attempt.kind !== 'detected') {
    return failedVerdict(usageRecords, scope, { error: attempt.error, latencyMs });
  }

  const blocking = blockingDetectors(attempt.firedDetectors, config);
  // A blocking detector that fired blocks even when another detector failed inside Enkrypt, so a
  // detector error never lets content through that Enkrypt did flag.
  if (attempt.error && blocking.length === 0) {
    return failedVerdict(usageRecords, scope, {
      error: attempt.error,
      detectorsFired: attempt.firedDetectors,
      latencyMs,
    });
  }
  const report = scanReport(scope, {
    decision: blocking.length === 0 ? 'allowed' : 'blocked',
    error: attempt.error ?? undefined,
    detectorsFired: attempt.firedDetectors,
    usageRecords,
    latencyMs,
  });
  logDecision(scope, report);
  return {
    verdict:
      blocking.length === 0
        ? { action: 'allow' }
        : {
            action: 'block',
            message: guardrailBlockMessage(blocking, attempt.resultMessage, coverage.part),
          },
    usageRecords,
    report,
  };
}

/**
 * The result of a scan whose calls were all skipped, because an earlier call or a cached verdict
 * blocked the request: no call, so it gates nothing, and its report covers only the cache lookup.
 */
export function skippedScanResult({
  config,
  coverage,
}: EnkryptGuardrailScan): EnkryptGuardrailScanResult {
  return {
    verdict: { action: 'skip' },
    usageRecords: [],
    report: {
      ...coverageReport(config, coverage),
      scanned_characters: 0,
      decision: 'allowed',
      error: null,
      detectors_fired: [],
      attempts: 0,
      credits_cost: null,
      latency_ms: 0,
    },
  };
}

type CoverageReport = Pick<
  EnkryptScanReport,
  | 'scan'
  | 'part'
  | 'detectors_enabled'
  | 'detectors_blocking'
  | 'verdict_cache'
  | 'total_characters'
  | 'total_segments'
  | 'cached_characters'
  | 'cached_segments'
  | 'total_units'
  | 'cached_units'
  | 'omitted_attachments'
>;

/** The report fields naming the detectors a scan uses. */
export function detectorsReport(
  config: EnkryptGuardrailConfig
): Pick<EnkryptScanReport, 'detectors_enabled' | 'detectors_blocking'> {
  return config.status === 'ready'
    ? {
        detectors_enabled: ENKRYPT_DETECTOR_IDS.filter(id => config.detectors[id] !== undefined),
        detectors_blocking: config.blockingDetectors,
      }
    : { detectors_enabled: [], detectors_blocking: [] };
}

/** The report fields describing what a scan covers, and with which detectors. */
export function coverageReport(
  config: EnkryptGuardrailConfig,
  coverage: EnkryptScanCoverage
): CoverageReport {
  return {
    scan: scanKind(config),
    part: coverage.part,
    ...detectorsReport(config),
    verdict_cache: coverage.cache,
    total_characters: coverage.totalCharacters,
    total_segments: coverage.totalSegments,
    cached_characters: coverage.cachedCharacters,
    cached_segments: coverage.cachedSegments,
    total_units: coverage.totalUnits,
    cached_units: coverage.cachedUnits,
    omitted_attachments: coverage.omittedAttachments,
  };
}

type ScanScope = {
  logFields: Record<string, unknown>;
  report: CoverageReport & Pick<EnkryptScanReport, 'scanned_characters'>;
};

/** A scope for a scan that made no call, so sent none of its text. */
function noTextSent(scope: ScanScope): ScanScope {
  return { ...scope, report: { ...scope.report, scanned_characters: 0 } };
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
    credits_cost: totalCredits(usageRecords.map(usageRecord => usageRecord.creditsCost)),
    latency_ms: outcome.latencyMs,
  };
}

/** A client disconnect is not an Enkrypt failure, so it is logged at debug level, as is `quiet`. */
function logDecision(scope: ScanScope, report: EnkryptScanReport, quiet = false): void {
  const fields = { ...scope.logFields, ...report };
  const failed = !quiet && report.error !== null && report.decision !== 'client_aborted';
  if (failed) warnExceptInTest('[enkrypt-guardrail] decision', fields);
  else console.debug('[enkrypt-guardrail] decision', fields);
}

/** The sum of the reported costs, or null when none was reported. */
export function totalCredits(costs: (number | null)[]): number | null {
  const reported = costs.filter(cost => cost !== null);
  return reported.length === 0 ? null : reported.reduce((sum, cost) => sum + cost, 0);
}

function failureDecision(kind: EnkryptScanKind, error: ScanError): EnkryptScanReport['decision'] {
  if (error === 'client_aborted') return 'client_aborted';
  if (kind === 'log_only') return 'error_logged';
  return isEnkryptFailure(error) ? 'error_fail_open' : 'error_fail_closed';
}

/**
 * A blocking scan that Enkrypt fails, by an error response, a timeout, or a network failure, fails
 * open: the content goes through unscanned. This is a deliberate tradeoff. Failing closed rejects
 * every request of every member of the organization for as long as Enkrypt is degraded, which is
 * unreasonable disruption for legitimate use. The failed content's verdict is cached as an allow
 * for only `ENKRYPT_FAILED_SCAN_CACHE_TTL_SECONDS`, so it is rescanned soon anyway, without every
 * step of an agent's conversation adding load to an Enkrypt that is already failing.
 *
 * Failures of Kilo's own, an invalid configuration or a missing or rejected API key, still fail
 * closed, since they would otherwise silently turn the guardrail off; so does content too large to
 * scan.
 */
function failureVerdict(
  kind: EnkryptScanKind,
  failure: { error: ScanError; closedVerdict?: EnkryptGuardrailVerdict }
): EnkryptGuardrailVerdict {
  if (kind === 'log_only') return { action: 'allow' };
  if (isEnkryptFailure(failure.error)) return { action: 'fail_open' };
  return failure.closedVerdict ?? { action: 'unavailable', reason: 'failed' };
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
    detectorsFired?: EnkryptDetectorId[];
    /** Logs the decision at debug level, even when it failed. */
    quiet?: boolean;
  }
): EnkryptGuardrailScanResult {
  const report = scanReport(scope, {
    decision: failureDecision(scope.report.scan, failure.error),
    error: failure.error,
    detectorsFired: failure.detectorsFired,
    usageRecords,
    latencyMs: failure.latencyMs,
  });
  logDecision(scope, report, failure.quiet);
  return {
    verdict: failureVerdict(scope.report.scan, failure),
    usageRecords:
      failure.error === 'client_aborted'
        ? usageRecords.filter(usageRecord => usageRecord.creditsCost !== null)
        : usageRecords,
    report,
  };
}
