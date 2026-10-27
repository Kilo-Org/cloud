import * as z from 'zod';
import type { EnkryptGuardrailApiKind, EnkryptGuardrailDecision } from '@kilocode/db/schema-types';
import type { EnkryptGuardrailCharge } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { sentryLogger, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

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

const TURN_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot scan more than ${ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US')} characters of new messages and tool results at once, so this request was not sent. Reduce the size of the latest tool output or message and retry.`;

/**
 * Enkrypt only blocks on block-type detectors, which answer with a block message in
 * `result_message`. `pii` is revise-type: its `result_message` is redacted input text, so a pii
 * detection is reported but never blocks and its message is never shown.
 */
const DETECTOR_TYPES = {
  injection_attack: 'block',
  nsfw: 'block',
  toxicity: 'block',
  pii: 'revise',
} as const;

type DetectorName = keyof typeof DETECTOR_TYPES;

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

export type EnkryptGuardrailVerdict =
  | { action: 'allow' }
  | { action: 'block'; message: string }
  | { action: 'unavailable' };

export type EnkryptGuardrailScanResult = {
  verdict: EnkryptGuardrailVerdict;
  charges: EnkryptGuardrailCharge[];
};

export type EnkryptDetectDependencies = {
  apiKey: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
};

type DetectAttempt =
  | {
      kind: 'detected';
      firedDetectors: DetectorName[];
      resultMessage: string | null;
      creditsCost: number | null;
    }
  | { kind: 'failed'; error: string; retryable: boolean; creditsCost: number | null };

const logDecision = sentryLogger('enkrypt-guardrail', 'info');

function isDetectorName(name: string): name is DetectorName {
  return Object.hasOwn(DETECTOR_TYPES, name);
}

function hasFired(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
}

function firedDetectors(summary: Record<string, unknown>): DetectorName[] {
  return Object.entries(summary).flatMap(([name, value]) =>
    isDetectorName(name) && hasFired(value) ? [name] : []
  );
}

function blockingDetectors(detectors: DetectorName[]): DetectorName[] {
  return detectors.filter(name => DETECTOR_TYPES[name] === 'block');
}

function parseCreditsCost(response: Response): number | null {
  const header = response.headers.get('x-enkrypt-credits-cost');
  if (header === null || header.trim() === '') return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
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
  return {
    kind: 'detected',
    firedDetectors: firedDetectors(parsed.data.summary),
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

export function guardrailBlockMessage(
  detectors: DetectorName[],
  resultMessage: string | null
): string {
  const reason =
    sanitizeBlockMessage(resultMessage) ??
    'The request was flagged as unsafe. Review it and retry.';
  return `Your organization's Enkrypt AI guardrail blocked this request (detected: ${detectors.join(', ')}). ${reason}`;
}

function attemptDecision(attempt: DetectAttempt): EnkryptGuardrailDecision {
  if (attempt.kind === 'failed') return 'error';
  return blockingDetectors(attempt.firedDetectors).length > 0 ? 'blocked' : 'allowed';
}

/**
 * Scans the turn delta once, retrying a single transient failure within the shared deadline, and
 * maps the result to a verdict. Never throws. Returns one ledger charge per Enkrypt call, including
 * calls that failed, so a blocked or failed request is still accounted for.
 */
export async function scanTurnDelta(
  scan: EnkryptGuardrailScan,
  deps: EnkryptDetectDependencies
): Promise<EnkryptGuardrailScanResult> {
  const { text } = scan;
  if (text.length === 0) return { verdict: { action: 'allow' }, charges: [] };

  const logFields = {
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
    detectors_enabled: Object.keys(scan.config.detectors),
    scanned_characters: text.length,
  };

  if (text.length > ENKRYPT_MAX_SCAN_CHARACTERS) {
    // Retrying cannot shrink the turn, so failing closed rejects it for good with the reason.
    return failedVerdict(scan, [], logFields, {
      error: 'turn_too_large',
      latencyMs: 0,
      closedVerdict: { action: 'block', message: TURN_TOO_LARGE_MESSAGE },
    });
  }

  const apiKey = deps.apiKey;
  if (!apiKey) {
    return failedVerdict(scan, [], logFields, { error: 'missing_api_key', latencyMs: 0 });
  }

  const body = JSON.stringify({
    text,
    detectors: scan.config.detectors,
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

  const charges = attempts.map((each): EnkryptGuardrailCharge => ({
    organizationId: scan.organizationId,
    kiloUserId: scan.kiloUserId,
    sessionId: scan.sessionId,
    apiKind: scan.apiKind,
    decision: attemptDecision(each),
    creditsCost: each.creditsCost,
  }));

  if (attempt.kind === 'failed') {
    return failedVerdict(scan, charges, logFields, { error: attempt.error, latencyMs });
  }

  const blocking = blockingDetectors(attempt.firedDetectors);
  const decided = {
    ...logFields,
    detectors_fired: attempt.firedDetectors,
    latency_ms: latencyMs,
    attempts: attempts.length,
    credits_cost: totalCredits(charges),
  };
  if (blocking.length === 0) {
    logDecision('[enkrypt-guardrail] decision', { ...decided, decision: 'allowed' });
    return { verdict: { action: 'allow' }, charges };
  }
  logDecision('[enkrypt-guardrail] decision', { ...decided, decision: 'blocked' });
  return {
    verdict: { action: 'block', message: guardrailBlockMessage(blocking, attempt.resultMessage) },
    charges,
  };
}

function totalCredits(charges: EnkryptGuardrailCharge[]): number | null {
  const costs = charges.flatMap(charge =>
    charge.creditsCost === null ? [] : [charge.creditsCost]
  );
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

function failedVerdict(
  scan: EnkryptGuardrailScan,
  charges: EnkryptGuardrailCharge[],
  logFields: Record<string, unknown>,
  failure: { error: string; latencyMs: number; closedVerdict?: EnkryptGuardrailVerdict }
): EnkryptGuardrailScanResult {
  const failClosed = scan.config.failMode === 'closed';
  const closedVerdict = failure.closedVerdict ?? { action: 'unavailable' };
  warnExceptInTest('[enkrypt-guardrail] decision', {
    ...logFields,
    decision: failClosed ? 'error_fail_closed' : 'error_fail_open',
    error: failure.error,
    latency_ms: failure.latencyMs,
    attempts: charges.length,
    credits_cost: totalCredits(charges),
  });
  return {
    verdict: failClosed ? closedVerdict : { action: 'allow' },
    charges,
  };
}
