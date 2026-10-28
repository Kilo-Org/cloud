import * as z from 'zod';
import type {
  EnkryptDetectorId,
  EnkryptGuardrailApiKind,
  EnkryptGuardrailDecision,
} from '@kilocode/db/schema-types';
import type { EnkryptGuardrailCall } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges';
import {
  ENKRYPT_DETECTOR_TYPES,
  ENKRYPT_SUMMARY_DETECTORS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

type ReadyEnkryptInputGuardrailConfig = Extract<EnkryptInputGuardrailConfig, { status: 'ready' }>;

export const ENKRYPT_DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';

/**
 * Bounds every attempt together. The gateway awaits the scan just before the upstream request, so
 * this is the most latency an enabled organization's request can gain.
 */
export const ENKRYPT_GUARDRAIL_TIMEOUT_MS = 3_000;

const MAX_ATTEMPTS = 2;

/**
 * A larger turn is not sent to Enkrypt. It is never truncated: the model would still read the
 * unscanned remainder, which is where an injected instruction in a large file read would sit.
 */
export const ENKRYPT_MAX_SCAN_CHARACTERS = 500_000;

const MAX_BLOCK_MESSAGE_LENGTH = 500;

/**
 * The enabled detectors cost at most 53 credits per call (`injection_attack` caps at 50), so a
 * larger header value is an Enkrypt bug. Clamping keeps the ledger insert and the balance debit
 * within column range instead of failing in the deferred write.
 */
export const MAX_ENKRYPT_CREDITS_PER_CALL = 1_000;

const TURN_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot scan more than ${ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US')} characters of new messages and tool results at once, so this request was not sent. Reduce the size of the latest tool output or message and retry.`;

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

/** `skip`: the organization has no guardrail, so nothing was scanned. */
export type EnkryptGuardrailVerdict =
  | { action: 'skip' }
  | { action: 'allow' }
  | { action: 'block'; message: string }
  | { action: 'unavailable' };

export type EnkryptGuardrailScanResult = {
  verdict: EnkryptGuardrailVerdict;
  charges: EnkryptGuardrailCall[];
};

export type EnkryptDetectDependencies = {
  apiKey: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
};

type DetectAttempt =
  | {
      kind: 'detected';
      firedDetectors: EnkryptDetectorId[];
      resultMessage: string | null;
      creditsCost: number | null;
    }
  | { kind: 'failed'; error: string; retryable: boolean; creditsCost: number | null };

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
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
  } catch (error) {
    return isAbortError(error)
      ? { kind: 'failed', error: 'timeout', retryable: false, creditsCost: null }
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
  } catch (error) {
    return {
      kind: 'failed',
      error: isAbortError(error) ? 'timeout' : 'invalid_response',
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
 * Scans the turn delta once, retrying a single transient failure within the shared deadline, and
 * maps the result to a verdict. Never throws. Returns one ledger charge per Enkrypt call, including
 * calls that failed, so a blocked or failed request is still accounted for. Any failure blocks the
 * request: an enabled guardrail never lets an unscanned turn reach the model.
 */
export async function scanTurnDelta(
  scan: EnkryptGuardrailScan,
  deps: EnkryptDetectDependencies
): Promise<EnkryptGuardrailScanResult> {
  const { text, config } = scan;
  if (text.length === 0) return { verdict: { action: 'allow' }, charges: [] };

  const baseLogFields = {
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
    scan_tool_results: config.scanToolResults,
    scanned_characters: text.length,
  };

  if (config.status === 'invalid') {
    return failedVerdict([], baseLogFields, { error: 'invalid_config', latencyMs: 0 });
  }

  const logFields = {
    ...baseLogFields,
    detectors_enabled: Object.keys(config.detectors),
    detectors_blocking: config.blockingDetectors,
  };

  if (text.length > ENKRYPT_MAX_SCAN_CHARACTERS) {
    // Retrying cannot shrink the turn, so the rejection carries the reason.
    return failedVerdict([], logFields, {
      error: 'turn_too_large',
      latencyMs: 0,
      closedVerdict: { action: 'block', message: TURN_TOO_LARGE_MESSAGE },
    });
  }

  const apiKey = deps.apiKey;
  if (!apiKey) {
    return failedVerdict([], logFields, { error: 'missing_api_key', latencyMs: 0 });
  }

  const body = JSON.stringify({
    text,
    detectors: config.detectors,
    user_metadata: { organization_id: scan.organizationId },
  });
  const signal = AbortSignal.timeout(deps.timeoutMs);
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

  const charges = attempts.map((each): EnkryptGuardrailCall => ({
    organizationId: scan.organizationId,
    kiloUserId: scan.kiloUserId,
    sessionId: scan.sessionId,
    apiKind: scan.apiKind,
    decision: attemptDecision(each, config),
    creditsCost: each.creditsCost,
  }));

  if (attempt.kind === 'failed') {
    return failedVerdict(charges, logFields, { error: attempt.error, latencyMs });
  }

  const blocking = blockingDetectors(attempt.firedDetectors, config);
  const decided = {
    ...logFields,
    detectors_fired: attempt.firedDetectors,
    latency_ms: latencyMs,
    attempts: attempts.length,
    credits_cost: totalCredits(charges),
  };
  if (blocking.length === 0) {
    console.debug('[enkrypt-guardrail] decision', { ...decided, decision: 'allowed' });
    return { verdict: { action: 'allow' }, charges };
  }
  console.debug('[enkrypt-guardrail] decision', { ...decided, decision: 'blocked' });
  return {
    verdict: { action: 'block', message: guardrailBlockMessage(blocking, attempt.resultMessage) },
    charges,
  };
}

function totalCredits(charges: EnkryptGuardrailCall[]): number | null {
  const costs = charges.flatMap(charge =>
    charge.creditsCost === null ? [] : [charge.creditsCost]
  );
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

function failedVerdict(
  charges: EnkryptGuardrailCall[],
  logFields: Record<string, unknown>,
  failure: { error: string; latencyMs: number; closedVerdict?: EnkryptGuardrailVerdict }
): EnkryptGuardrailScanResult {
  warnExceptInTest('[enkrypt-guardrail] decision', {
    ...logFields,
    decision: 'error_fail_closed',
    error: failure.error,
    latency_ms: failure.latencyMs,
    attempts: charges.length,
    credits_cost: totalCredits(charges),
  });
  return { verdict: failure.closedVerdict ?? { action: 'unavailable' }, charges };
}
